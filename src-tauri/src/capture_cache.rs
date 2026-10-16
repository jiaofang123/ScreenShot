use image::RgbaImage;
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Default)]
pub struct CaptureCache {
    next_id: AtomicU64,
    current: Mutex<Option<(u64, Arc<RgbaImage>)>>,
}

impl CaptureCache {
    pub fn store(&self, image: RgbaImage) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        *self.current.lock() = Some((id, Arc::new(image)));
        id
    }

    pub fn get(&self, id: u64) -> Result<Arc<RgbaImage>, String> {
        self.current
            .lock()
            .as_ref()
            .filter(|(current_id, _)| *current_id == id)
            .map(|(_, image)| Arc::clone(image))
            .ok_or_else(|| "截图已失效，请重新截图".to_string())
    }

    pub fn release(&self, id: u64) {
        let mut current = self.current.lock();
        if current
            .as_ref()
            .is_some_and(|(current_id, _)| *current_id == id)
        {
            *current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_pixels_without_copying_and_rejects_stale_ids() {
        let cache = CaptureCache::default();
        let first = cache.store(RgbaImage::new(10, 10));
        let in_flight = cache.get(first).unwrap();
        assert!(Arc::ptr_eq(&in_flight, &cache.get(first).unwrap()));
        let second = cache.store(RgbaImage::new(20, 20));
        assert_ne!(first, second);
        assert!(cache.get(first).is_err());
        cache.release(first);
        assert_eq!(cache.get(second).unwrap().dimensions(), (20, 20));
        cache.release(second);
        assert!(cache.get(second).is_err());
        assert_eq!(in_flight.dimensions(), (10, 10));
    }
}
