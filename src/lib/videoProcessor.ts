import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { Annotation } from '@/components/VideoAnnotationTool';

export class VideoProcessor {
  private ffmpeg: FFmpeg;
  private isLoaded = false;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  async load() {
    if (this.isLoaded) return;

    try {
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      
      this.ffmpeg.on('log', ({ message }) => {
        console.log(message);
      });

      // Add progress monitoring and error handling
      this.ffmpeg.on('progress', ({ progress }) => {
        console.log('FFmpeg loading progress:', progress);
      });

      // Load FFmpeg with better error handling
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
      });

      this.isLoaded = true;
      console.log('FFmpeg loaded successfully');
    } catch (error) {
      console.error('Failed to load FFmpeg:', error);
      this.isLoaded = false;
      throw new Error(`FFmpeg initialization failed: ${error.message}`);
    }
  }

  async processAnnotation(
    videoFile: File, 
    annotation: Annotation, 
    canvasResolution: { width: number; height: number },
    videoResolution: { width: number; height: number },
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.isLoaded) {
      await this.load();
    }

    // Memory check before processing
    try {
      const memoryInfo = (performance as any).memory;
      if (memoryInfo && memoryInfo.usedJSHeapSize > 500 * 1024 * 1024) {
        console.warn('High memory usage detected, attempting cleanup');
        if (typeof (window as any).gc === 'function') {
          (window as any).gc();
        }
      }
    } catch (e) {
      // Memory API not available
    }

    try {
      console.log('Starting video processing:', {
        filename: annotation.filename,
        fileSize: Math.round(videoFile.size / 1024 / 1024) + 'MB',
        cropArea: annotation.cropArea,
        timeRange: annotation.timeRange
      });

      // Write video file to FFmpeg with better error handling
      await this.ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
      console.log('Video file written to FFmpeg successfully');

      const { timeRange, cropArea } = annotation;

      if (!videoResolution || !canvasResolution || !canvasResolution.width || !canvasResolution.height) {
        throw new Error('Missing resolution info');
      }

      // Calculate scale factors - should be identical for both axes if aspect ratio preserved
      const videoAspect = videoResolution.width / videoResolution.height;
      const canvasAspect = canvasResolution.width / canvasResolution.height;

      let scale = 1;
      let offsetX = 0;
      let offsetY = 0;

      if (canvasAspect > videoAspect) {
        // Video cao hơn canvas → letterbox ngang
        scale = videoResolution.height / canvasResolution.height;
        offsetX = (canvasResolution.width - videoResolution.width / scale) / 2;
      } else {
        // Video rộng hơn canvas → letterbox dọc
        scale = videoResolution.width / canvasResolution.width;
        offsetY = (canvasResolution.height - videoResolution.height / scale) / 2;
      }

      const preciseX = (cropArea.x - offsetX) * scale;
      const preciseY = (cropArea.y - offsetY) * scale;
      const preciseW = cropArea.width * scale;
      const preciseH = cropArea.height * scale;

      // Round và giới hạn biên như trước
      const cropX = Math.max(0, Math.round(preciseX / 2) * 2);
      const cropY = Math.max(0, Math.round(preciseY / 2) * 2);
      const cropW = Math.max(32, Math.round(preciseW / 2) * 2);
      const cropH = Math.max(32, Math.round(preciseH / 2) * 2);

      const finalCropW = Math.min(cropW, videoResolution.width - cropX);
      const finalCropH = Math.min(cropH, videoResolution.height - cropY);

      // FFmpeg command to crop and trim video
      const duration = timeRange.end - timeRange.start;
      
      // Validate duration
      if (duration <= 0 || duration > 3600) { // Max 1 hour
        throw new Error('Invalid duration');
      }

      console.log('Debug Final Crop:', {

        cropArea,
        cropX, cropY, 
        cropW: finalCropW, 
        cropH: finalCropH,
        videoResolution,
        canvasResolution,
        duration
      });

      // Add progress monitoring for FFmpeg execution
      let progressCallback: (() => void) | undefined;
      if (onProgress) {
        progressCallback = () => {
          const currentProgress = Math.min(95, (Date.now() % 10000) / 100);
          onProgress(currentProgress);
        };
        const progressInterval = setInterval(progressCallback, 100);
        setTimeout(() => clearInterval(progressInterval), 5000);
      }

      console.log('Executing FFmpeg command with parameters:', {
        start: timeRange.start,
        duration,
        crop: `${finalCropW}:${finalCropH}:${cropX}:${cropY}`
      });

      await this.ffmpeg.exec([
        '-i', 'input.mp4',
        '-ss', timeRange.start.toString(),
        '-t', duration.toString(),
        '-filter:v', `crop=${finalCropW}:${finalCropH}:${cropX}:${cropY}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Faster encoding
        '-crf', '23', // Quality setting
        '-c:a', 'aac',
        '-movflags', '+faststart', // Optimize for web playback
        '-avoid_negative_ts', 'make_zero',
        '-y',
        'output.mp4'
      ]);

      console.log('FFmpeg processing completed');

      // Verify output file exists
      const files = await this.ffmpeg.listDir('/');
      const outputExists = files.some(file => file.name === 'output.mp4');
      if (!outputExists) {
        throw new Error('Output file was not created');
      }

      // Read the processed video
      const data = await this.ffmpeg.readFile('output.mp4');
      
      if (!data || data.length === 0) {
        throw new Error('Output file is empty');
      }

      console.log('Video processing successful, output size:', Math.round(data.length / 1024) + 'KB');
      
      if (onProgress) {
        onProgress(100);
      }

      // Handle FileData properly - it's a Uint8Array from FFmpeg
      // Create a new Uint8Array to avoid SharedArrayBuffer issues
      const buffer = data instanceof Uint8Array ? data.buffer : (data as any).buffer;
      const uint8Array = new Uint8Array(buffer);
      return new Blob([uint8Array.buffer], { type: 'video/mp4' });

    } catch (error) {
      console.error('FFmpeg processing error:', error);
      throw new Error(`Video processing failed: ${error.message || 'Unknown error'}`);
    } finally {
      // Always cleanup, even on error
      try {
        await this.ffmpeg.deleteFile('input.mp4');
        await this.ffmpeg.deleteFile('output.mp4');
      } catch (cleanupError) {
        console.warn('Cleanup error:', cleanupError);
      }
    }
  }

  async processMultipleAnnotations(
    videoFile: File,
    annotations: Annotation[],
    canvasResolution: { width: number; height: number },
    videoResolution: { width: number; height: number },
    onProgress?: (progress: number, currentIndex: number) => void
  ): Promise<{ filename: string; blob: Blob }[]> {
    const results: { filename: string; blob: Blob }[] = [];
    const BATCH_SIZE = 15; // Process 15 annotations at a time to avoid memory issues
    const CLEANUP_DELAY = 500; // ms delay between batches for memory cleanup

    console.log(`Processing ${annotations.length} annotations in batches of ${BATCH_SIZE}`);

    // Process annotations in batches
    for (let batchStart = 0; batchStart < annotations.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, annotations.length);
      const batch = annotations.slice(batchStart, batchEnd);
      
      console.log(`Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(annotations.length / BATCH_SIZE)} (annotations ${batchStart + 1}-${batchEnd})`);

      // Process current batch
      for (let i = 0; i < batch.length; i++) {
        const globalIndex = batchStart + i;
        const annotation = batch[i];
        
        if (onProgress) {
          onProgress((globalIndex / annotations.length) * 100, globalIndex);
        }

        try {
          const blob = await this.processAnnotation(
            videoFile, 
            annotation, 
            canvasResolution,
            videoResolution
          );
          
          results.push({
            filename: annotation.filename,
            blob
          });

          console.log(`Processed ${globalIndex + 1}/${annotations.length}: ${annotation.filename}`);
        } catch (error) {
          console.error(`Failed to process annotation ${globalIndex + 1}:`, error);
          throw new Error(`Failed to process annotation "${annotation.label}": ${error.message}`);
        }
      }

      // Cleanup between batches (except for the last batch)
      if (batchEnd < annotations.length) {
        console.log('Performing memory cleanup between batches...');
        
        // Terminate and reload FFmpeg to free memory
        try {
          await this.terminate();
          await this.load();
        } catch (error) {
          console.warn('Error during FFmpeg reload:', error);
          // Continue anyway, it will reload on next processAnnotation
        }

        // Force garbage collection hint (if available)
        if (typeof (window as any).gc === 'function') {
          try {
            (window as any).gc();
          } catch (e) {
            // GC not available
          }
        }

        // Small delay to allow browser to cleanup
        await new Promise(resolve => setTimeout(resolve, CLEANUP_DELAY));
      }
    }

    if (onProgress) {
      onProgress(100, annotations.length);
    }

    console.log(`Successfully processed all ${annotations.length} annotations`);
    return results;
  }

  async terminate() {
    if (this.isLoaded) {
      await this.ffmpeg.terminate();
      this.isLoaded = false;
    }
  }
}

// Singleton instance
export const videoProcessor = new VideoProcessor();