// ScreenShot macOS capture helper. Uses ScreenCaptureKit directly, never a browser.
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreImage
import ImageIO

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

struct Options: Decodable {
    var mode: String; var sourceId: UInt32; var fps: Int; var audio: Bool
    var microphone: Bool?; var cursor: Bool?; var clicks: Bool?; var originalResolution: Bool
    var crop: Crop?
    var excludedProcessIDs: [Int32]?
    struct Crop: Decodable { var x: Double; var y: Double; var width: Double; var height: Double }
}

// Keep controller windows separate from ordinary Chrome windows. Never exclude
// Chrome as an application: its other windows are legitimate recording targets.
func isRecorderController(_ title: String?) -> Bool {
    (title ?? "").contains("ScreenShot · 本机录屏")
}

@available(macOS 13.0, *)
func isToolApplication(_ application: SCRunningApplication?, excluding processes: [Int32]) -> Bool {
    guard let application = application else { return false }
    return application.bundleIdentifier == "com.amamda.screenshot" || processes.contains(application.processID)
}

@available(macOS 13.0, *)
@MainActor func displayScale(_ display: SCDisplay) -> CGFloat {
    NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID })?.backingScaleFactor ?? 1
}

@available(macOS 13.0, *)
@MainActor func desktopFilter(_ display: SCDisplay, content: SCShareableContent, excluding processes: [Int32]) -> SCContentFilter {
    let own = content.applications.filter { isToolApplication($0, excluding: processes) }
    // Exceptions invert the application rule. Include only controller windows
    // belonging to other applications, so no tool window is accidentally restored.
    let controllers = content.windows.filter { !isToolApplication($0.owningApplication, excluding: processes) && isRecorderController($0.title) }
    let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: controllers)
    if #available(macOS 14.2, *) { filter.includeMenuBar = false }
    return filter
}

@available(macOS 13.0, *)
final class DesktopSnapshot: NSObject, SCStreamOutput, @unchecked Sendable {
    var continuation: CheckedContinuation<CVPixelBuffer, Error>?
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixels = sample.imageBuffer,
              let attachment = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo:Any]],
              attachment.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
              let reply = continuation else { return }
        continuation = nil; reply.resume(returning: pixels)
    }
    @MainActor func capture(_ displayID: UInt32, path: String, excluding processes: [Int32]) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw NSError(domain:"ScreenShot",code:2,userInfo:[NSLocalizedDescriptionKey:"屏幕不可用，请重新选择"]) }
        let config = SCStreamConfiguration(); config.width = Int(display.frame.width * displayScale(display)); config.height = Int(display.frame.height * displayScale(display)); config.showsCursor = false
        let stream = SCStream(filter:desktopFilter(display,content:content,excluding:processes),configuration:config,delegate:nil)
        try stream.addStreamOutput(self,type:.screen,sampleHandlerQueue:DispatchQueue(label:"ScreenShot.snapshot"))
        let pixels: CVPixelBuffer = try await withCheckedThrowingContinuation { reply in
            continuation = reply
            Task { do { try await stream.startCapture() } catch { if let pending = continuation { continuation = nil; pending.resume(throwing:error) } } }
        }
        try? await stream.stopCapture()
        let context = CIContext()
        guard let image = context.createCGImage(CIImage(cvPixelBuffer:pixels), from:CGRect(x:0,y:0,width:CVPixelBufferGetWidth(pixels),height:CVPixelBufferGetHeight(pixels))),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath:path) as CFURL,"public.png" as CFString,1,nil) else { throw NSError(domain:"ScreenShot",code:7) }
        CGImageDestinationAddImage(destination,image,nil)
        guard CGImageDestinationFinalize(destination) else { throw NSError(domain:"ScreenShot",code:8) }
        emit(["event":"snapshotSaved"])
    }
}

@available(macOS 13.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ScreenShot.capture.writer")
    var writer: AVAssetWriter!
    var video: AVAssetWriterInput!
    var audio: AVAssetWriterInput?
    var microphone: AVAssetWriterInput?
    var stream: SCStream?
    var systemAudioStream: SCStream?
    var start = CMTime.invalid, offset = CMTime.zero, pauseAt = CMTime.invalid
    var paused = false, finishing = false
    var lastVideo: CMSampleBuffer?
    var fps = 30

    func retime(_ sample: CMSampleBuffer, subtract: CMTime) -> CMSampleBuffer? {
        var count = 0
        guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr else { return nil }
        var timings = Array(repeating: CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timings, entriesNeededOut: &count) == noErr else { return nil }
        for index in timings.indices {
            timings[index].presentationTimeStamp = timings[index].presentationTimeStamp - subtract
            if timings[index].decodeTimeStamp.isValid { timings[index].decodeTimeStamp = timings[index].decodeTimeStamp - subtract }
        }
        var result: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: count, sampleTimingArray: &timings, sampleBufferOut: &result) == noErr else { return nil }
        return result
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event":"sourceEnded", "message":error.localizedDescription])
        Task { await finish() }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !paused, !finishing, sample.isValid, CMSampleBufferDataIsReady(sample) else { return }
        if type == .screen {
            guard CMSampleBufferGetImageBuffer(sample) != nil else { return }
            if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo:Any]],
               let raw = attachments.first?[.status] as? Int, raw != SCFrameStatus.complete.rawValue { return }
            if !start.isValid { start = sample.presentationTimeStamp; writer.startSession(atSourceTime: start) }
            lastVideo = sample
        }
        guard start.isValid, let adjusted = retime(sample, subtract: offset), adjusted.presentationTimeStamp >= start else { return }
        var input: AVAssetWriterInput? = type == .screen ? video : audio
        if #available(macOS 15.0, *), type == .microphone { input = microphone }
        if let input = input, input.isReadyForMoreMediaData {
            if !input.append(adjusted), writer.status == .failed { emit(["event":"error", "message":writer.error?.localizedDescription ?? "视频写入失败"]) }
        }
    }

    @MainActor func prepare(_ options: Options, path: String) async throws {
        if options.microphone == true, !(await AVCaptureDevice.requestAccess(for:.audio)) { throw NSError(domain:"ScreenShot",code:6,userInfo:[NSLocalizedDescriptionKey:"麦克风未授权，请在系统设置中允许 ScreenShot 使用麦克风"]) }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let config = SCStreamConfiguration()
        let filter: SCContentFilter
        var systemAudioFilter: SCContentFilter?
        let sourceSize: CGSize
        let scale: CGFloat
        if options.mode == "window" {
            guard let window = content.windows.first(where: { $0.windowID == options.sourceId }) else { throw NSError(domain:"ScreenShot", code:1, userInfo:[NSLocalizedDescriptionKey:"窗口已关闭，请刷新录制来源"] ) }
            guard !isToolApplication(window.owningApplication,excluding:options.excludedProcessIDs ?? []), !isRecorderController(window.title) else { throw NSError(domain:"ScreenShot",code:9,userInfo:[NSLocalizedDescriptionKey:"不能录制 ScreenShot 工具或录屏控制页，请选择其他窗口"]) }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceSize = window.frame.size
            if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
            else { scale = NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor ?? 1 }
        } else {
            guard let display = content.displays.first(where: { $0.displayID == options.sourceId }) else { throw NSError(domain:"ScreenShot", code:2, userInfo:[NSLocalizedDescriptionKey:"屏幕不可用，请重新选择"] ) }
            filter = desktopFilter(display,content:content,excluding:options.excludedProcessIDs ?? [])
            if options.audio {
                // Window exceptions can affect audio for the entire browser app.
                // Keep system audio on a separate audio-only stream, excluding
                // ScreenShot while retaining sound from ordinary browser tabs.
                let own = content.applications.filter { isToolApplication($0,excluding:options.excludedProcessIDs ?? []) }
                systemAudioFilter = SCContentFilter(display:display,excludingApplications:own,exceptingWindows:[])
            }
            scale = displayScale(display)
            if let crop = options.crop, options.mode == "region" {
                let region = CGRect(x: crop.x * display.frame.width, y: crop.y * display.frame.height, width: crop.width * display.frame.width, height: crop.height * display.frame.height)
                guard region.width * scale >= 8, region.height * scale >= 8, CGRect(origin:.zero, size:display.frame.size).contains(region) else { throw NSError(domain:"ScreenShot", code:3, userInfo:[NSLocalizedDescriptionKey:"录制区域无效"] ) }
                config.sourceRect = region; sourceSize = region.size
            } else { sourceSize = display.frame.size }
        }
        let limit = options.originalResolution ? CGSize(width:3840,height:2160) : CGSize(width:1920,height:1080)
        let ratio = min(scale, limit.width / sourceSize.width, limit.height / sourceSize.height)
        config.width = max(2, Int(sourceSize.width * ratio) / 2 * 2)
        config.height = max(2, Int(sourceSize.height * ratio) / 2 * 2)
        config.minimumFrameInterval = CMTime(value:1, timescale:Int32(options.fps)); fps = options.fps
        config.queueDepth = 5
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = options.cursor ?? true
        config.capturesAudio = options.audio && systemAudioFilter == nil; config.sampleRate = 48000; config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) { config.captureMicrophone = options.microphone ?? false; config.showMouseClicks = options.clicks ?? false }
        else if options.microphone == true { throw NSError(domain:"ScreenShot", code:4, userInfo:[NSLocalizedDescriptionKey:"原生麦克风录制需要 macOS 15 或更新版本"] ) }
        writer = try AVAssetWriter(outputURL: URL(fileURLWithPath:path), fileType:.mp4)
        writer.shouldOptimizeForNetworkUse = true
        video = AVAssetWriterInput(mediaType:.video, outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264, AVVideoWidthKey:config.width, AVVideoHeightKey:config.height,
            AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:options.originalResolution ? 16000000 : 8000000, AVVideoExpectedSourceFrameRateKey:options.fps]])
        video.expectsMediaDataInRealTime = true; writer.add(video)
        func audioInput() -> AVAssetWriterInput {
            let input = AVAssetWriterInput(mediaType:.audio, outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC, AVSampleRateKey:48000, AVNumberOfChannelsKey:2, AVEncoderBitRateKey:128000])
            input.expectsMediaDataInRealTime = true; writer.add(input); return input
        }
        if options.audio { audio = audioInput() }
        if #available(macOS 15.0, *), options.microphone == true { microphone = audioInput() }
        guard writer.startWriting() else { throw writer.error ?? NSError(domain:"ScreenShot", code:5) }
        let stream = SCStream(filter:filter, configuration:config, delegate:self)
        try stream.addStreamOutput(self, type:.screen, sampleHandlerQueue:queue)
        if config.capturesAudio { try stream.addStreamOutput(self, type:.audio, sampleHandlerQueue:queue) }
        if #available(macOS 15.0, *), options.microphone == true { try stream.addStreamOutput(self, type:.microphone, sampleHandlerQueue:queue) }
        self.stream = stream
        try await stream.startCapture()
        if let audioFilter = systemAudioFilter {
            let audioConfig = SCStreamConfiguration()
            audioConfig.width = 2; audioConfig.height = 2; audioConfig.minimumFrameInterval = CMTime(value:1,timescale:1)
            audioConfig.capturesAudio = true; audioConfig.sampleRate = 48000; audioConfig.channelCount = 2; audioConfig.excludesCurrentProcessAudio = true
            let audioStream = SCStream(filter:audioFilter,configuration:audioConfig,delegate:self)
            try audioStream.addStreamOutput(self,type:.audio,sampleHandlerQueue:queue)
            self.systemAudioStream = audioStream
            try await audioStream.startCapture()
        }
        emit(["event":"started", "width":config.width, "height":config.height, "hasAudio":options.audio || options.microphone == true])
    }
    func control(_ action: String) {
        queue.async {
            if self.finishing { return }
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            if action == "pause", !self.paused { self.paused = true; self.pauseAt = now; emit(["event":"paused"]) }
            if action == "resume", self.paused { self.offset = self.offset + now - self.pauseAt; self.paused = false; emit(["event":"resumed"]) }
        }
    }
    func finish() async {
        let allowed = queue.sync { () -> Bool in if finishing { return false }; finishing = true; return true }
        guard allowed else { return }
        try? await stream?.stopCapture()
        try? await systemAudioStream?.stopCapture()
        queue.sync {
            if start.isValid, let last = lastVideo, video.isReadyForMoreMediaData {
                let end = (paused ? pauseAt : CMClockGetTime(CMClockGetHostTimeClock())) - offset
                if let final = retime(last, subtract:last.presentationTimeStamp - end), end > last.presentationTimeStamp - offset { _ = video.append(final) }
            }
            video?.markAsFinished(); audio?.markAsFinished(); microphone?.markAsFinished()
        }
        if !start.isValid { writer.cancelWriting(); emit(["event":"error", "message":"没有收到视频画面，请检查屏幕录制权限"]); exit(1) }
        await writer.finishWriting()
        if writer.status == .completed { emit(["event":"saved"]); exit(0) }
        else { emit(["event":"error", "message":writer.error?.localizedDescription ?? "视频保存失败"]); exit(1) }
    }
}

@available(macOS 13.0, *)
@MainActor func run() async {
    do {
        if CommandLine.arguments.count > 4, CommandLine.arguments[1] == "snapshot" {
            try await DesktopSnapshot().capture(UInt32(CommandLine.arguments[2])!,path:CommandLine.arguments[3],excluding:[Int32(CommandLine.arguments[4])!]);return
        }
        if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "self-test" {
            guard isRecorderController("ScreenShot · 本机录屏 - Google Chrome"), !isRecorderController("普通网页 - Google Chrome"), !isRecorderController("ScreenShot 使用教程") else { throw NSError(domain:"SelfTest",code:4) }
            // Synthetic frames exercise the native writer and pause timestamp adjustment without accessing any screen.
            let target = URL(fileURLWithPath: CommandLine.arguments[2])
            let writer = try AVAssetWriter(outputURL:target,fileType:.mp4)
            let input = AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:128,AVVideoHeightKey:72])
            writer.add(input); guard writer.startWriting() else { throw writer.error! }; writer.startSession(atSourceTime:.zero)
            let timer = Recorder()
            for index in 0..<30 {
                var image:CVPixelBuffer?
                CVPixelBufferCreate(kCFAllocatorDefault,128,72,kCVPixelFormatType_32BGRA,[kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,&image)
                guard let image=image else { throw NSError(domain:"SelfTest",code:1) }
                CVPixelBufferLockBaseAddress(image,[])
                let bytes=CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to:UInt8.self)
                for y in 0..<72 { for x in 0..<128 { let p=y*CVPixelBufferGetBytesPerRow(image)+x*4;bytes[p]=20;bytes[p+1]=180;bytes[p+2]=30;bytes[p+3]=255 } }
                CVPixelBufferUnlockBaseAddress(image,[])
                var format:CMVideoFormatDescription?
                CMVideoFormatDescriptionCreateForImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:image,formatDescriptionOut:&format)
                var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:30),presentationTimeStamp:CMTime(value:Int64(index+(index>=15 ? 60 : 0)),timescale:30),decodeTimeStamp:.invalid)
                var sample:CMSampleBuffer?
                CMSampleBufferCreateReadyWithImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:image,formatDescription:format!,sampleTiming:&timing,sampleBufferOut:&sample)
                guard let adjusted=timer.retime(sample!,subtract:index>=15 ? CMTime(seconds:2,preferredTimescale:30) : .zero),adjusted.presentationTimeStamp==CMTime(value:Int64(index),timescale:30) else {throw NSError(domain:"SelfTest",code:2)}
                while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds:1_000_000) }
                guard input.append(adjusted) else {throw writer.error!}
            }
            writer.endSession(atSourceTime:CMTime(seconds:1,preferredTimescale:30));input.markAsFinished();await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error! }
            let duration=try await AVURLAsset(url:target).load(.duration)
            guard abs(duration.seconds-1)<0.05 else { throw NSError(domain:"SelfTest",code:3) }
            emit(["event":"selfTestPassed","width":128,"height":72,"duration":duration.seconds]);return
        }
        if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "list" {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly:true)
            var sources: [[String:Any]] = content.displays.map { ["id":$0.displayID,"kind":"desktop","name":"屏幕 \($0.displayID)","width":Int($0.frame.width * displayScale($0)),"height":Int($0.frame.height * displayScale($0))] }
            let excluded = CommandLine.arguments.count > 2 ? [Int32(CommandLine.arguments[2]) ?? 0] : []
            sources += content.windows.filter { !isToolApplication($0.owningApplication,excluding:excluded) && !isRecorderController($0.title) && $0.frame.width > 80 && $0.frame.height > 60 && !($0.title ?? "").isEmpty }.map {
                ["id":$0.windowID,"kind":"window","name":"\($0.owningApplication?.applicationName ?? "应用") · \($0.title ?? "窗口")","width":Int($0.frame.width),"height":Int($0.frame.height)]
            }
            emit(["sources":sources]); return
        }
        let options = try JSONDecoder().decode(Options.self, from:Data(CommandLine.arguments[1].utf8))
        let recorder = Recorder()
        try await recorder.prepare(options, path:CommandLine.arguments[2])
        DispatchQueue.global().async {
            while let line = readLine() { if line == "stop" { Task { await recorder.finish() }; return }; recorder.control(line) }
            Task { await recorder.finish() }
        }
        while true { try await Task.sleep(nanoseconds:1_000_000_000) }
    } catch { emit(["event":"error", "message":error.localizedDescription]); exit(1) }
}

// Window filters call WindowServer APIs that require an initialized AppKit
// connection. A headless Swift command-line process has no connection by default.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
Task { @MainActor in if #available(macOS 13.0, *) { await run(); exit(0) } else { emit(["event":"error","message":"原生录屏需要 macOS 13 或更新版本"]); exit(1) } }
dispatchMain()
