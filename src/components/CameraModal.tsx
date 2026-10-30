import React, { useRef, useState, useEffect } from 'react';
import { Camera, X, RefreshCw, Check, AlertCircle } from 'lucide-react';

interface CameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
  lang: 'bn' | 'en';
}

export const CameraModal: React.FC<CameraModalProps> = ({
  isOpen,
  onClose,
  onCapture,
  lang,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const startCamera = async () => {
    setError(null);
    setCapturedPhoto(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err: any) {
      console.error('Camera access error:', err);
      setError(
        lang === 'bn'
          ? 'ক্যামেরা চালু করা সম্ভব হয়নি। অনুগ্রহ করে ব্রাউজার পারমিশন চেক করুন।'
          : 'Could not access camera. Please check browser permissions.'
      );
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    setCapturedPhoto(null);
  };

  const takeSnapshot = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      setCapturedPhoto(dataUrl);
    }
  };

  const confirmSend = () => {
    if (capturedPhoto) {
      onCapture(capturedPhoto);
      stopCamera();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-in fade-in">
      <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-lg overflow-hidden flex flex-col text-app transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'ক্যামেরা স্ন্যাপশট' : 'Camera Snapshot'} >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-token">
          <div className="flex items-center gap-2">
            <Camera className="w-5 h-5 text-primary" />
            <span className="font-semibold text-app text-sm bn-safe bn-text">
              {lang === 'bn' ? 'ক্যামেরা স্ন্যাপশট' : 'Camera Snapshot'}
            </span>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg transition-colors"
            aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video Viewport / Photo Preview */}
        <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden">
          {error ? (
            <div className="text-center p-6 space-y-2">
              <AlertCircle className="w-8 h-8 text-danger mx-auto" />
              <p className="text-xs text-danger max-w-xs">{error}</p>
            </div>
          ) : capturedPhoto ? (
            <img src={capturedPhoto} alt="Captured" className="w-full h-full object-contain" />
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform -scale-x-100"
            />
          )}

          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Action Controls */}
        <div className="p-4 border-t border-token flex items-center justify-between bg-surface">
          {capturedPhoto ? (
            <>
              <button
                onClick={() => setCapturedPhoto(null)}
                className="flex items-center gap-1.5 px-4 min-h-[44px] text-xs font-semibold text-app bg-pressed hover:bg-bubble-in rounded-[var(--r-control)] transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                <span>{lang === 'bn' ? 'পুনরায় তুলুন' : 'Retake'}</span>
              </button>

              <button
                onClick={confirmSend}
                className="flex items-center gap-1.5 px-5 min-h-[44px] text-xs font-semibold text-white bg-[#0B6E4F] hover:bg-[#095C42] rounded-[var(--r-control)] shadow-md transition-colors"
              >
                <Check className="w-4 h-4" />
                <span>{lang === 'bn' ? 'মেসেজে পাঠান' : 'Send Photo'}</span>
              </button>
            </>
          ) : (
            <div className="w-full flex justify-center">
              <button
                onClick={takeSnapshot}
                disabled={!stream || !!error}
                className="flex items-center gap-2 px-6 min-h-[44px] bg-[#0B6E4F] hover:bg-[#095C42] disabled:opacity-50 text-white rounded-full text-xs font-semibold shadow-md transition-[transform,colors] hover:scale-105 active:scale-95 [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)]"
              >
                <Camera className="w-4 h-4" />
                <span>{lang === 'bn' ? 'ছবি তুলুন (Snap Photo)' : 'Capture Snapshot'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
