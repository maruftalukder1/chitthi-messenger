import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  X,
  QrCode,
  Download,
  Camera,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  Upload,
  Radio,
  AlertCircle,
  UserPlus
} from 'lucide-react';

// Generated-artefact colours (SVG data-URIs, QR codes) resolve from the live
// design tokens at runtime — Team C's cssToken pattern (Phase 2): no hex
// literals in component files.
function cssToken(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

interface OfflineQrModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSendOfflineMessage: (content: string, type: 'offline_qr', meta?: { fileName?: string }) => void;
  /** Phase 1.4.3: a scanned `chitthi://user/<username>` payload routes here
   * (add-contact flow) instead of being posted as raw chat text. */
  onAddContact?: (username: string) => void;
  lang: 'bn' | 'en';
}

// Scheme check (Phase 1.4.3): profile QRs encode `chitthi://user/<segment>`
// where the segment is the @username when claimed, else the user id.
// Returns the segment, or null for any other payload (offline transfer).
export function parseChitthiUserPayload(data: string): string | null {
  const m = /^chitthi:\/\/user\/([A-Za-z0-9_]+)\/?$/.exec((data || '').trim());
  return m ? m[1] : null;
}

export const OfflineQrModal: React.FC<OfflineQrModalProps> = ({
  isOpen,
  onClose,
  onSendOfflineMessage,
  onAddContact,
  lang,
}) => {
  const [mode, setMode] = useState<'generate' | 'scan'>('generate');
  // The modal has two clearly separated purposes (Phase 1.4.3):
  //  - 'contact':  "Add contact" — My QR encodes chitthi://user/<username>
  //  - 'transfer': "Offline transfer" — free-form offline payload text
  const readSessionUser = (): { id?: string; username?: string } => {
    try {
      const raw = localStorage.getItem('chithi_auth_user');
      if (raw) {
        const u = JSON.parse(raw);
        return {
          id: u?.id ? String(u.id) : undefined,
          username: u?.username ? String(u.username) : undefined
        };
      }
    } catch {
      /* no stored session */
    }
    return {};
  };
  // My-QR contact payload: chitthi://user/<username> when the session user
  // has claimed one; the id-link form otherwise (with a claim nudge in UI).
  const buildContactPayload = (): string | null => {
    const u = readSessionUser();
    if (u.username) return `chitthi://user/${u.username}`;
    if (u.id) return `chitthi://user/${u.id}`;
    return null;
  };
  const hasUsername = (): boolean => !!readSessionUser().username;
  // Phase 0.4: no hard-coded personalised payload. The default offline
  // transfer payload is built from the CURRENT signed-in user (stored
  // session in `chithi_auth_user`): their real user id.
  const buildOwnPayload = (): string => {
    const u = readSessionUser();
    if (u.id) {
      const params = new URLSearchParams({ user: u.id });
      if (u.username) params.set('username', u.username);
      return `OFFLINE_SYNC://chithi/p2p_mesh?${params.toString()}`;
    }
    return 'OFFLINE_SYNC://chithi/p2p_mesh';
  };
  const ownPayloadRef = useRef<string>(buildOwnPayload());
  const [transferText, setTransferText] = useState<string>(() => ownPayloadRef.current);
  const [contactPayload, setContactPayload] = useState<string | null>(() => buildContactPayload());
  const [sessionHasUsername, setSessionHasUsername] = useState<boolean>(() => hasUsername());
  const [qrPurpose, setQrPurpose] = useState<'contact' | 'transfer'>(() =>
    buildContactPayload() ? 'contact' : 'transfer'
  );
  const qrText = qrPurpose === 'contact' ? contactPayload || '' : transferText;

  // Refresh the default payloads each time the modal opens (the signed-in
  // user may have changed); never overwrite transfer text the user typed.
  useEffect(() => {
    if (!isOpen) return;
    const fresh = buildOwnPayload();
    setTransferText((prev) => (prev === ownPayloadRef.current || prev === '' ? fresh : prev));
    ownPayloadRef.current = fresh;
    setContactPayload(buildContactPayload());
    setSessionHasUsername(hasUsername());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Scanner state
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [scannedResult, setScannedResult] = useState<string | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Generate QR
  useEffect(() => {
    if (isOpen && qrText) {
      QRCode.toDataURL(qrText, {
        width: 320,
        margin: 2,
        color: {
          dark: cssToken('--c-text', 'black'),
          light: cssToken('--c-bg', 'white')
        }
      })
        .then((url) => setQrDataUrl(url))
        .catch(console.error);
    }
  }, [isOpen, qrText]);

  // Clean up camera stream on close or mode switch
  const stopCamera = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setScannedResult(null);
      setScannerError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (mode === 'scan' && isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [mode, facingMode, isOpen]);

  // Start real camera scanner
  const startCamera = async () => {
    setScannerError(null);
    setScannedResult(null);
    stopCamera();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode }
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        setIsCameraActive(true);
        requestAnimationFrame(tickScan);
      }
    } catch (err: any) {
      console.warn('Camera access issue:', err);
      setScannerError(
        lang === 'bn'
          ? 'ক্যামেরা চালু করা যায়নি। আপনি নিচে থেকে ছবি আপলোড করেও স্ক্যান করতে পারেন।'
          : 'Unable to access live camera. You can also upload a QR photo/screenshot below.'
      );
      setIsCameraActive(false);
    }
  };

  // Live frame scan loop using jsQR
  const tickScan = () => {
    if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });

          if (code && code.data) {
            handleDecodedCode(code.data);
            return; // stop scanning after successful decode
          }
        }
      }
    }
    animFrameRef.current = requestAnimationFrame(tickScan);
  };

  const handleDecodedCode = (data: string) => {
    stopCamera();
    setScannedResult(data);
  };

  // Decode from uploaded image file
  const handleUploadScanImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code && code.data) {
            handleDecodedCode(code.data);
          } else {
            setScannerError(
              lang === 'bn'
                ? 'ছবিটিতে কোনো কিউআর কোড পাওয়া যায়নি। অন্য ছবি চেষ্টা করুন।'
                : 'No QR code found in this image. Please try another.'
            );
          }
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (!isOpen) return null;

  const handleDownloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `chithi_offline_qr_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopyDecoded = () => {
    if (!scannedResult) return;
    navigator.clipboard?.writeText(scannedResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleImportToChat = () => {
    if (!scannedResult) return;
    onSendOfflineMessage(scannedResult, 'offline_qr', {
      fileName: 'offline_transferred_data.qr'
    });
    onClose();
  };

  // A scanned profile QR never becomes a chat message: it routes to the
  // add-contact flow (Phase 1.4.3 scheme check).
  const scannedContact = scannedResult ? parseChitthiUserPayload(scannedResult) : null;

  const handleAddScannedContact = () => {
    if (!scannedContact) return;
    onAddContact?.(scannedContact);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
      <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl relative text-app  max-h-[90vh] overflow-y-auto transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'অফলাইন কিউআর ও পি২পি ট্রান্সফার' : 'Offline QR & P2P Data Transfer'} >
        {/* Hidden Canvas and Image Inputs for decoding */}
        <canvas ref={canvasRef} className="hidden" />
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleUploadScanImage}
          accept="image/*"
          className="hidden"
        />

        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3 border-b border-token ">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-surface  text-primary  flex items-center justify-center">
              <QrCode className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold">
                {lang === 'bn' ? 'অফলাইন কিউআর ও পি২পি ট্রান্সফার' : 'Offline QR & P2P Data Transfer'}
              </h3>
              <p className="text-[11px] text-app-faint">
                {lang === 'bn' ? 'ইন্টারনেট ছাড়াই ডাটা শেয়ারিং' : 'Zero-internet optical & mesh transfer'}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg transition-colors"
           aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Toggle Bar */}
        <div className="flex items-center gap-1 bg-bubble-in  p-1 rounded-xl my-4 text-xs font-semibold">
          <button
            onClick={() => {
              stopCamera();
              setMode('generate');
            }}
            className={`flex-1 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              mode === 'generate'
                ? 'bg-app  text-primary  shadow-xs'
                : 'text-app-2 hover:text-app '
            }`}
           aria-pressed={mode === 'generate'} >
            <QrCode className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'কিউআর তৈরি করুন' : 'Generate QR'}</span>
          </button>
          <button
            onClick={() => setMode('scan')}
            className={`flex-1 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              mode === 'scan'
                ? 'bg-app  text-primary  shadow-xs'
                : 'text-app-2 hover:text-app '
            }`}
           aria-pressed={mode === 'scan'} >
            <Camera className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'ক্যামেরা দিয়ে স্ক্যান' : 'Live Camera Scanner'}</span>
          </button>
        </div>

        {/* MODE 1: GENERATE QR */}
        {mode === 'generate' && (
          <div className="space-y-4 text-center">
            {/* Purpose toggle: Add contact vs Offline transfer (kept clearly
                separate — a contact QR adds a person, a transfer QR moves data) */}
            <div className="flex items-center gap-1 bg-bubble-in  p-1 rounded-xl text-xs font-semibold">
              <button
                onClick={() => setQrPurpose('contact')}
                className={`flex-1 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                  qrPurpose === 'contact'
                    ? 'bg-app  text-primary  shadow-xs'
                    : 'text-app-2 hover:text-app '
                }`}
               aria-pressed={qrPurpose === 'contact'} >
                <UserPlus className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'কন্টাক্ট যোগ করুন' : 'Add contact'}</span>
              </button>
              <button
                onClick={() => setQrPurpose('transfer')}
                className={`flex-1 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                  qrPurpose === 'transfer'
                    ? 'bg-app  text-primary  shadow-xs'
                    : 'text-app-2 hover:text-app '
                }`}
               aria-pressed={qrPurpose === 'transfer'} >
                <Radio className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'অফলাইন ট্রান্সফার' : 'Offline transfer'}</span>
              </button>
            </div>

            {qrPurpose === 'contact' ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-app ">
                  {lang === 'bn' ? 'আমার প্রোফাইল কিউআর' : 'My profile QR'}
                </p>
                <p className="font-mono text-[11px] break-all bg-surface  border border-token  rounded-xl px-3 py-2 text-app ">
                  {contactPayload || (lang === 'bn' ? 'কোনো সেশন পাওয়া যায়নি' : 'No signed-in session found')}
                </p>
                {!sessionHasUsername && (
                  <p className="text-[11px] text-away  leading-snug">
                    {lang === 'bn'
                      ? 'টিপ: প্রোফাইল সেটিংস থেকে একটি @username নিন — তাহলে মানুষ আইডি ছাড়াই আপনাকে খুঁজে পাবে।'
                      : 'Tip: claim a @username in Profile settings so people can find you by name instead of an ID link.'}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-left text-xs font-semibold text-app  mb-1">
                  {lang === 'bn' ? 'অফলাইন ট্রান্সফার ডাটা বা মেসেজ:' : 'Offline Transfer Data / Message:'}
                </label>
                <textarea
                  rows={2}
                  value={transferText}
                  onChange={(e) => setTransferText(e.target.value)}
                  placeholder="Enter offline message or payload..."
                  className="w-full bg-surface  border border-token  rounded-xl p-2.5 text-xs text-app    "
                 aria-label={lang === 'bn' ? 'অফলাইন ট্রান্সফার ডাটা বা মেসেজ' : 'Offline Transfer Data / Message'} />
              </div>
            )}

            {/* High-Resolution QR Display */}
            <div className="p-4 bg-app rounded-[var(--r-card)] border border-token shadow-sm w-60 h-60 mx-auto flex items-center justify-center">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Offline QR" className="w-full h-full object-contain" />
              ) : (
                <QrCode className="w-16 h-16 text-app-faint animate-pulse" />
              )}
            </div>

            <p className="text-[11px] text-app-2  leading-relaxed px-4">
              {qrPurpose === 'contact'
                ? lang === 'bn'
                  ? 'অন্য কেউ এই কিউআর স্ক্যান করলে সরাসরি আপনাকে কন্টাক্ট হিসেবে যোগ করতে পারবে।'
                  : 'Anyone who scans this QR can add you as a contact right away.'
                : lang === 'bn'
                  ? 'ইন্টারনেট বা ওয়াইফাই ছাড়াই অন্য যেকোনো ফোন থেকে এই অ্যাপে ক্যামেরা দিয়ে স্ক্যান করে সরাসরি ডাটা গ্রহণ করতে পারবেন।'
                  : 'Other devices can scan this QR code directly with their camera to receive offline data without internet or WiFi.'}
            </p>

            {/* Centered Save QR Button (User Requested: "সেভ কিউআর হ্যাঁ এই অপশনটা এটা মাঝে আসুক। এটা মাঝখানে দেওয়া থাকুক") */}
            <div className="pt-2 flex justify-center">
              <button
                type="button"
                onClick={handleDownloadQr}
                className="w-full max-w-xs py-3 bg-[#0B6E4F] hover:bg-[#095C42] active:scale-[0.99] text-white rounded-xl text-xs sm:text-sm font-bold shadow-md  flex items-center justify-center gap-2 transition-colors mx-auto"
              >
                <Download className="w-4 h-4" />
                <span>{lang === 'bn' ? 'সেভ কিউআর (Save QR Code)' : 'Save QR Code'}</span>
              </button>
            </div>
          </div>
        )}

        {/* MODE 2: LIVE CAMERA SCANNER */}
        {mode === 'scan' && (
          <div className="space-y-4">
            {/* If a QR code was scanned */}
            {scannedResult ? (
              <div className="space-y-4 text-center animate-in zoom-in-95">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-surface  text-online  flex items-center justify-center shadow-inner">
                  <CheckCircle2 className="w-8 h-8" />
                </div>

                <div>
                  <h4 className="text-base font-bold text-app ">
                    {scannedContact
                      ? lang === 'bn'
                        ? 'কন্টাক্ট কিউআর স্ক্যান হয়েছে!'
                        : 'Contact QR Scanned!'
                      : lang === 'bn'
                        ? 'অফলাইন ডাটা স্ক্যান সফল হয়েছে!'
                        : 'Offline QR Data Scanned!'}
                  </h4>
                  <p className="text-xs text-app-2  mt-1">
                    {scannedContact
                      ? lang === 'bn'
                        ? 'এটি একটি Chitthi প্রোফাইল কিউআর'
                        : 'This is a Chitthi profile QR'
                      : lang === 'bn'
                        ? 'ব্লুটুথ / অপটিক্যাল মেশ প্রোটোকলে ডাটা গৃহীত হয়েছে'
                        : 'Received via Optical P2P Mesh Transfer'}
                  </p>
                </div>

                {/* Scanned Payload Card */}
                <div className="p-3.5 rounded-2xl bg-surface  border border-token  text-left text-xs space-y-2">
                  <span className="text-[10px] uppercase font-bold text-app-faint tracking-wider">
                    {lang === 'bn' ? 'গৃহীত ডাটা:' : 'Decoded Payload:'}
                  </span>
                  <div className="font-mono text-xs break-all bg-app  p-2.5 rounded-xl border border-token  text-app  max-h-32 overflow-y-auto">
                    {scannedResult}
                  </div>
                </div>

                {/* Action Buttons — a profile QR adds a contact; it is
                    never posted into a chat as raw text */}
                <div className="space-y-2 pt-1">
                  {scannedContact ? (
                    <>
                      <button
                        type="button"
                        onClick={handleAddScannedContact}
                        disabled={!onAddContact}
                        className="w-full py-2.5 bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-xl text-xs font-bold shadow-md  flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                      >
                        <UserPlus className="w-4 h-4" />
                        <span>
                          {lang === 'bn' ? 'কন্টাক্ট যোগ করুন' : 'Add Contact'} — @{scannedContact}
                        </span>
                      </button>
                      {!onAddContact && (
                        <p className="text-[11px] text-app-2 ">
                          {lang === 'bn'
                            ? 'কন্টাক্ট যোগ করার সুবিধা এই স্ক্রিনে সংযুক্ত নেই — @username কপি করে ব্যবহার করুন।'
                            : 'Add-contact is not wired on this screen yet — copy the @username to use it.'}
                        </p>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleImportToChat}
                      className="w-full py-2.5 bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-xl text-xs font-bold shadow-md  flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{lang === 'bn' ? 'চ্যাটে ইনপুট করুন' : 'Import to Chat'}</span>
                    </button>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopyDecoded}
                      className="flex-1 py-2 bg-bubble-in  hover:bg-pressed  text-app  rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-online" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? (lang === 'bn' ? 'কপি হয়েছে' : 'Copied') : (lang === 'bn' ? 'কপি করুন' : 'Copy Text')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScannedResult(null);
                        startCamera();
                      }}
                      className="flex-1 py-2 bg-bubble-in  hover:bg-pressed  text-app  rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>{lang === 'bn' ? 'আবার স্ক্যান' : 'Scan Again'}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Live Camera Viewfinder */}
                <div className="relative w-full aspect-square max-w-[280px] mx-auto rounded-3xl overflow-hidden bg-black border-2 border-token shadow-xl flex items-center justify-center">
                  <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    playsInline
                    autoPlay
                    muted
                  />

                  {/* Laser scan line & target brackets */}
                  <div className="absolute inset-6 border-2 border-[var(--c-primary)] rounded-2xl pointer-events-none">
                    <div className="w-full h-0.5 bg-primary opacity-80 animate-pulse absolute top-1/2 -translate-y-1/2" />
                  </div>

                  {!isCameraActive && (
                    <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center p-4 text-center">
                      <Camera className="w-10 h-10 text-white/70 mb-2 animate-bounce" />
                      <p className="text-xs text-white/85">
                        {lang === 'bn' ? 'ক্যামেরা চালু করা হচ্ছে...' : 'Initializing Camera Scanner...'}
                      </p>
                    </div>
                  )}
                </div>

                {scannerError && (
                  <div className="p-3 bg-surface  border border-token  rounded-xl text-away  text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{scannerError}</span>
                  </div>
                )}

                {/* Camera Controls & File Upload Alternative */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
                    }
                    className="flex-1 py-2 px-3 bg-bubble-in  hover:bg-pressed  text-app  rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{lang === 'bn' ? 'ক্যামেরা সুইচ' : 'Switch Camera'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-2 px-3 bg-bubble-in  hover:bg-pressed  text-app  rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5 text-primary" />
                    <span>{lang === 'bn' ? 'ছবি থেকে স্ক্যান' : 'Upload Image'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
