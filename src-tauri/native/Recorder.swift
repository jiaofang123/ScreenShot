// ScreenShot macOS capture helper. Uses ScreenCaptureKit directly, never a browser.
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

struct Options: Decodable {
    var mode: String; var sourceId: UInt32; var fps: Int; var audio: Bool
    var microphone: Bool?; var cursor: Bool?; var clicks: Bool?; var originalResolution: Bool
    var crop: Crop?
    struct Crop: Decodable { var x: Double; var y: Double; var width: Double; var height: Double }
}

@available(macOS 13.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "ScreenShot.capture.writer")
    var writer: AVAssetWriter!
    var video: AVAssetWriterInput!
    var audio: AVAssetWriterInput?
    var microphone: AVAssetWriterInput?
    var stream: SCStream?
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

    func prepare(_ options: Options, path: String) async throws {
        if options.microphone == true, !(await AVCaptureDevice.requestAccess(for:.audio)) { throw NSError(domain:"ScreenShot",code:6,userInfo:[NSLocalizedDescriptionKey:"麦克风未授权，请在系统设置中允许 ScreenShot 使用麦克风"]) }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let config = SCStreamConfiguration()
        let filter: SCContentFilter
        let sourceSize: CGSize
        let scale: CGFloat
        if options.mode == "window" {
            guard let window = content.windows.first(where: { $0.windowID == options.sourceId }) else { throw NSError(domain:"ScreenShot", code:1, userInfo:[NSLocalizedDescriptionKey:"窗口已关闭，请刷新录制来源"] ) }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceSize = window.frame.size
            scale = 2
        } else {
            guard let display = content.displays.first(where: { $0.displayID == options.sourceId }) else { throw NSError(domain:"ScreenShot", code:2, userInfo:[NSLocalizedDescriptionKey:"屏幕不可用，请重新选择"] ) }
            // Exclude ScreenShot's own windows from desktop and region captures.
            let own = content.applications.filter { $0.bundleIdentifier == "com.amamda.screenshot" }
            filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
            scale = CGFloat(display.width) / max(1, display.frame.width)
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
        config.capturesAudio = options.audio; config.sampleRate = 48000; config.channelCount = 2
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
        if options.audio { try stream.addStreamOutput(self, type:.audio, sampleHandlerQueue:queue) }
        if #available(macOS 15.0, *), options.microphone == true { try stream.addStreamOutput(self, type:.microphone, sampleHandlerQueue:queue) }
        self.stream = stream
        try await stream.startCapture()
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
func run() async {
    do {
        if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "self-test" {
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
            var sources: [[String:Any]] = content.displays.map { ["id":$0.displayID,"kind":"desktop","name":"屏幕 \($0.displayID)","width":$0.width,"height":$0.height] }
            sources += content.windows.filter { $0.owningApplication?.bundleIdentifier != "com.amamda.screenshot" && $0.frame.width > 80 && $0.frame.height > 60 && !($0.title ?? "").isEmpty }.map {
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

Task { if #available(macOS 13.0, *) { await run(); exit(0) } else { emit(["event":"error","message":"原生录屏需要 macOS 13 或更新版本"]); exit(1) } }
dispatchMain()
