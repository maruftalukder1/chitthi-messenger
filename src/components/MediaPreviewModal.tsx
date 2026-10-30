import React from 'react';
import { X, Download } from 'lucide-react';

interface MediaPreviewModalProps {
  media: {
    url: string;
    type: 'image' | 'video';
    title?: string;
  } | null;
  onClose: () => void;
  lang: 'bn' | 'en';
}

export const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({
  media,
  onClose,
  lang,
}) => {
  if (!media) return null;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = media.url;
    a.download = media.title || (media.type === 'image' ? 'pulsechat_image.png' : 'pulsechat_video.mp4');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 animate-in fade-in" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'মিডিয়া প্রিভিউ' : 'Media preview'} >
      {/* Top action bar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          onClick={handleDownload}
          className="glass-pill flex items-center gap-1.5 px-4 min-h-[44px] text-app text-xs font-semibold transition-[opacity,transform] [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)]"
          title={lang === 'bn' ? 'ডাউনলোড করুন' : 'Download file'} aria-label={lang === 'bn' ? 'ডাউনলোড করুন' : 'Download file'}
        >
          <Download className="w-4 h-4" />
          <span>{lang === 'bn' ? 'ডাউনলোড' : 'Download'}</span>
        </button>

        <button
          onClick={onClose}
          className="glass-pill w-11 h-11 flex items-center justify-center text-app transition-[opacity,transform] [transition-duration:var(--dur-press)] [transition-timing-function:var(--ease-spring)]"
          title="Close preview" aria-label="Close preview"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {media.title && (
        <div className="absolute top-4 left-6 text-sm font-medium text-white/85 truncate max-w-md bn-safe bn-text">
          {media.title}
        </div>
      )}

      {/* Main preview container */}
      <div className="max-w-4xl max-h-[85vh] w-full flex items-center justify-center overflow-hidden">
        {media.type === 'image' ? (
          <img
            src={media.url}
            alt={media.title || 'Preview'}
            className="max-w-full max-h-[85vh] object-contain rounded-[var(--r-card)] shadow-2xl"
          />
        ) : (
          <video
            src={media.url}
            controls
            autoPlay
            className="max-w-full max-h-[85vh] rounded-[var(--r-card)] shadow-2xl bg-black"
          />
        )}
      </div>
    </div>
  );
};
