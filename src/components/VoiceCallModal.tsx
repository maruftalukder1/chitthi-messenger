import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PhoneOff,
  Phone,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  ShieldCheck,
  X,
  SwitchCamera,
  ScreenShare,
  ScreenShareOff,
  Minimize2,
  Maximize2
} from 'lucide-react';
import { User } from '../types/chat';
import { socketService } from '../services/socketService';
import { getIceServers } from '../services/iceConfig';
import { startRingtone, stopRingtone, isRingtoneEnabled } from '../utils/ringtone';

export interface CallSession {
  direction: 'out' | 'in';
  peerId?: string;
  peerName: string;
  callType: 'audio' | 'video';
}

interface VoiceCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUser?: User | null;
  targetRoomName?: string;
  callType?: 'audio' | 'video';
  lang: 'bn' | 'en';
  currentUser: User;
  roomId: string;
  session: CallSession | null;
  onCallEnded?: (info: { durationSec: number; connected: boolean; direction: 'out' | 'in'; peerId?: string; peerName: string; callType: 'audio' | 'video'; endReason?: 'no-answer' | 'busy' | 'declined' | 'ended'; dataUsed?: string }) => void;
}

/** Format a real cumulative byte total from RTC stats — never estimated. */
function formatDataUsed(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  if (totalBytes < 1024 * 1024) return `${Math.round(totalBytes / 1024)} KB`;
  return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
}

type CallStatus = 'calling' | 'ringing' | 'connecting' | 'connected' | 'no-answer' | 'ended' | 'busy' | 'declined' | 'failed';

export const VoiceCallModal: React.FC<VoiceCallModalProps> = ({
  isOpen,
  onClose,
  targetUser,
  targetRoomName,
  callType = 'audio',
  lang,
  currentUser,
  roomId,
  session,
  onCallEnded,
}) => {
  const direction: 'out' | 'in' = session?.direction ?? 'out';
  const effectiveCallType: 'audio' | 'video' = session?.callType ?? callType;
  const peerId = session?.peerId ?? targetUser?.id;
  const peerName = session?.peerName ?? targetUser?.name ?? targetRoomName ?? 'Recipient';

  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(effectiveCallType === 'video');
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [status, setStatus] = useState<CallStatus>(direction === 'in' ? 'ringing' : 'calling');
  const [needsTapForSound, setNeedsTapForSound] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [mediaNote, setMediaNote] = useState<string | null>(null);
  const [hasVideoTrack, setHasVideoTrack] = useState(false);
  // Phase 1.3: screen share + connection-quality state.
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  // Call quality (Mega Round): 3 = good, 2 = fair, 1 = poor, null = no
  // stats yet. Derived from the same getStats poll that tracks data use;
  // this REPLACES the old separate weak-connection badge (merged signal).
  const [callQuality, setCallQuality] = useState<1 | 2 | 3 | null>(null);
  // Minimize / PiP tile state (Mega Round). The tile is a CSS re-layout
  // of this same modal — no element is unmounted, so the PC, streams and
  // the always-mounted remote <audio> all stay alive.
  const [isMinimized, setIsMinimized] = useState(false);
  const [tilePos, setTilePos] = useState<{ x: number; y: number } | null>(null);
  // True when the remote stream carries a video track during an AUDIO call
  // (i.e. the peer started sharing their screen) — drives the display-only
  // remote video element in the audio layout.
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Latest remote stream — lets the audio layout's display-only video
  // element attach when it mounts AFTER ontrack set hasRemoteVideo.
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteReadyRef = useRef(false);
  const acceptedRef = useRef(false);
  const connectedRef = useRef(false);
  const durationRef = useRef(0);
  const endedRef = useRef(false);
  // Why the call ended — drives CallLog type mapping in App (declined vs missed).
  const endReasonRef = useRef<'no-answer' | 'busy' | 'declined' | 'ended'>('ended');
  const facingModeRef = useRef<'user' | 'environment'>('user');
  // Connecting timeout (~20s to reach 'connected') and ICE-restart bookkeeping.
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceDisconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceRestartInFlightRef = useRef(false);
  const iceRestartNeededRef = useRef(false);
  // True when local media acquisition failed BEFORE any invite/accept was
  // signalled — such a non-call must not produce a call-log entry on close.
  const mediaFailedRef = useRef(false);
  // Phase 1.3 screen-share bookkeeping: the display stream/track being sent,
  // the camera track it replaced (null when the call had no video sender —
  // audio call or audio-only fallback — in which case a sender was ADDED
  // and must be removed again on stop), and a live mirror of the state.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackBeforeShareRef = useRef<MediaStreamTrack | null>(null);
  const addedVideoSenderRef = useRef<RTCRtpSender | null>(null);
  const sharingRef = useRef(false);
  const screenPreviewRef = useRef<HTMLVideoElement | null>(null);
  // Phase 1.3 stats polling: previous inbound-rtp counters for the
  // per-interval packet-loss rate, plus the consecutive-degraded streak
  // (the weak badge needs 2 bad polls in a row so a single spike on a
  // healthy call never flashes it).
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevInboundRef = useRef<{ received: number; lost: number } | null>(null);
  const weakStreakRef = useRef(0);
  // Latest cumulative bytesSent+bytesReceived from stats polls (Mega
  // Round honest data-used). null = stats never available → the field
  // is OMITTED from the call-end payload, never estimated.
  const dataBytesRef = useRef<number | null>(null);
  // PiP tile drag bookkeeping.
  const tileOuterRef = useRef<HTMLDivElement | null>(null);
  const tileDragRef = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const tileDragMovedRef = useRef(false);

  const screenShareSupported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const attachRemoteStream = useCallback(
    (stream: MediaStream) => {
      remoteStreamRef.current = stream;
      // ECHO FIX (0.7): the remote stream must be audible through EXACTLY ONE
      // element. Previously it was attached to BOTH the <video> and the
      // <audio> element in video calls, so remote audio played twice (echo).
      // Video calls → the <video> element is the single audible element.
      // Audio calls → the dedicated <audio> element is the single audible
      // element (no visible <video> exists; this gap broke PawMatch audio).
      const audibleEl: HTMLMediaElement | null =
        effectiveCallType === 'video' ? remoteVideoRef.current : remoteAudioRef.current;
      const silentEl: HTMLMediaElement | null =
        effectiveCallType === 'video' ? remoteAudioRef.current : remoteVideoRef.current;
      if (silentEl) {
        // Phase 1.3 exception: in an AUDIO call the <video> element is a
        // muted, display-only surface for a peer's screen share. Attaching
        // the stream there does NOT break the echo rule — the element is
        // `muted`, so remote audio still plays through exactly one element
        // (the <audio> above). Without a video track it stays detached.
        if (effectiveCallType === 'audio' && stream.getVideoTracks().length > 0) {
          silentEl.srcObject = stream;
          silentEl.play().catch(() => {});
        } else {
          silentEl.srcObject = null;
        }
      }
      if (audibleEl) {
        audibleEl.srcObject = stream;
        audibleEl.play().catch(() => setNeedsTapForSound(true));
      }
    },
    [effectiveCallType]
  );

  const cleanup = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    // Phase 1.3: stop stats polling and any live screen share.
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    prevInboundRef.current = null;
    weakStreakRef.current = 0;
    sharingRef.current = false;
    if (screenTrackRef.current) {
      screenTrackRef.current.onended = null;
      screenTrackRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    cameraTrackBeforeShareRef.current = null;
    addedVideoSenderRef.current = null;
    if (iceDisconnectedTimerRef.current) {
      clearTimeout(iceDisconnectedTimerRef.current);
      iceDisconnectedTimerRef.current = null;
    }
    iceRestartInFlightRef.current = false;
    iceRestartNeededRef.current = false;
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onnegotiationneeded = null;
        pcRef.current.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    pendingIceRef.current = [];
    remoteReadyRef.current = false;
    remoteStreamRef.current = null;
  }, []);

  const finishAndClose = useCallback(
    (notifyPeer: boolean, finalStatus: CallStatus, reason?: 'no-answer' | 'busy' | 'declined' | 'ended') => {
      if (endedRef.current) return;
      endedRef.current = true;
      if (reason) endReasonRef.current = reason;
      else if (finalStatus === 'no-answer') endReasonRef.current = 'no-answer';
      else if (finalStatus === 'busy') endReasonRef.current = 'busy';
      else if (finalStatus === 'declined') endReasonRef.current = 'declined';
      if (notifyPeer && peerId) {
        // Phase 1.3 regression guard: an untargeted signal falls back to a
        // room-scoped relay on the server — a call frame must only ever
        // reach the one intended peer, so never send without a peerId.
        socketService.sendCallSignal({ signalType: 'end', targetUserId: peerId, roomId });
      }
      // A call that never got signalled (local media failed before
      // invite/accept) is not a call — do not write a call-log entry for it.
      if (!mediaFailedRef.current) {
        // Honest data-used: only the real cumulative byte total the stats
        // polls actually observed; omitted entirely when stats never ran.
        const totalBytes = dataBytesRef.current;
        const dataUsed =
          typeof totalBytes === 'number' && totalBytes > 0 ? formatDataUsed(totalBytes) : undefined;
        onCallEnded?.({
          durationSec: durationRef.current,
          connected: connectedRef.current,
          direction,
          // Carry the peer ID so the call log can resolve the peer BY ID
          // (App previously had to match by display name — see 0.4).
          peerId,
          peerName,
          callType: effectiveCallType,
          endReason: endReasonRef.current,
          ...(dataUsed ? { dataUsed } : {}),
        });
      }
      setStatus(finalStatus);
      cleanup();
      // Give the user time to read terminal statuses before the modal
      // vanishes (~900ms; a failure state gets longer, ~1.6s).
      setTimeout(
        onClose,
        finalStatus === 'failed'
          ? 1600
          : finalStatus === 'no-answer' || finalStatus === 'ended' || finalStatus === 'busy' || finalStatus === 'declined'
          ? 900
          : 0
      );
    },
    [cleanup, direction, effectiveCallType, onCallEnded, onClose, peerId, peerName, roomId]
  );

  // ── ICE restart (0.7) ──────────────────────────────────────────────────────
  // restartIce() alone is a no-op without renegotiation: a fresh offer with
  // iceRestart must be created and sent through the existing call:signal
  // 'offer' path, and the peer answers it through the existing 'answer' path.
  // Guarded so simultaneous triggers (iceconnectionstatechange +
  // onnegotiationneeded) collapse into one renegotiation.
  const renegotiateIceRestart = useCallback(async () => {
    const pc = pcRef.current;
    iceRestartNeededRef.current = false;
    if (!pc || endedRef.current) return;
    if (iceRestartInFlightRef.current) return;
    // No remote description yet → no established session to restart.
    if (!remoteReadyRef.current) return;
    iceRestartInFlightRef.current = true;
    try {
      try {
        pc.restartIce();
      } catch {
        /* ignore */
      }
      const offer = await pc.createOffer({ iceRestart: true });
      if (endedRef.current || pcRef.current !== pc) return;
      await pc.setLocalDescription(offer);
      if (endedRef.current || pcRef.current !== pc) return;
      socketService.sendCallSignal({ signalType: 'offer', targetUserId: peerId, roomId, signal: offer });
    } catch (err) {
      console.warn('ICE restart renegotiation failed:', err);
    } finally {
      // Grace period before another restart attempt is allowed.
      setTimeout(() => {
        iceRestartInFlightRef.current = false;
      }, 5000);
    }
  }, [peerId, roomId]);

  // ── Track-change renegotiation (1.3) ───────────────────────────────────────
  // Adding/removing a video sender mid-call (screen share on an audio call)
  // needs a fresh offer through the same 'offer'/'answer' path the ICE
  // restart uses. replaceTrack() swaps need NO renegotiation. If the state
  // machine is busy (e.g. an ICE restart is in flight), retry shortly —
  // start/stop share re-check live state when the retry runs.
  const renegotiateForTrackChange = useCallback(async (): Promise<void> => {
    const pc = pcRef.current;
    if (!pc || endedRef.current || !remoteReadyRef.current) return;
    if (pc.signalingState !== 'stable') {
      setTimeout(() => {
        void renegotiateForTrackChange();
      }, 1200);
      return;
    }
    try {
      const offer = await pc.createOffer();
      if (endedRef.current || pcRef.current !== pc) return;
      await pc.setLocalDescription(offer);
      if (endedRef.current || pcRef.current !== pc) return;
      socketService.sendCallSignal({ signalType: 'offer', targetUserId: peerId, roomId, signal: offer });
    } catch (err) {
      console.warn('Track-change renegotiation failed:', err);
    }
  }, [peerId, roomId]);

  // ── Screen share (1.3) ─────────────────────────────────────────────────────
  const stopScreenShare = useCallback(
    async (fromEndedEvent = false) => {
      if (!sharingRef.current) return;
      sharingRef.current = false;
      setIsScreenSharing(false);
      const pc = pcRef.current;
      const screenTrack = screenTrackRef.current;
      screenTrackRef.current = null;
      if (screenTrack) {
        screenTrack.onended = null;
        if (!fromEndedEvent) {
          try {
            screenTrack.stop();
          } catch {
            /* ignore */
          }
        }
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => {
          if (t !== screenTrack) t.stop();
        });
        screenStreamRef.current = null;
      }
      // Revert to the pre-share camera/mute state: the saved camera track
      // was never stopped (only replaced on the sender), so its enabled
      // flag — including a user-muted camera — is exactly as it was.
      const cameraTrack = cameraTrackBeforeShareRef.current;
      cameraTrackBeforeShareRef.current = null;
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
        localVideoRef.current.play().catch(() => {});
      }
      if (!pc || endedRef.current) {
        addedVideoSenderRef.current = null;
        return;
      }
      const sender =
        (screenTrack ? pc.getSenders().find((s) => s.track === screenTrack) : undefined) ??
        addedVideoSenderRef.current ??
        pc.getSenders().find((s) => s.track?.kind === 'video');
      const wasAdded = !!sender && sender === addedVideoSenderRef.current;
      addedVideoSenderRef.current = null;
      if (!sender) return;
      try {
        if (cameraTrack) {
          await sender.replaceTrack(cameraTrack);
        } else if (wasAdded) {
          // The call had no video sender before sharing (audio call /
          // audio-only fallback): remove ours and renegotiate it away.
          pc.removeTrack(sender);
          await renegotiateForTrackChange();
        } else {
          await sender.replaceTrack(null);
        }
      } catch {
        /* call is ending or the sender is gone — nothing to revert */
      }
    },
    [renegotiateForTrackChange]
  );

  const startScreenShare = useCallback(async () => {
    if (sharingRef.current || endedRef.current) return;
    const pc = pcRef.current;
    if (!pc || !screenShareSupported) return;
    let screenStream: MediaStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      // User dismissed the picker (or the browser refused) — stay in-call.
      return;
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack || endedRef.current || pcRef.current !== pc) {
      screenStream.getTracks().forEach((t) => t.stop());
      return;
    }
    screenStreamRef.current = screenStream;
    screenTrackRef.current = screenTrack;
    cameraTrackBeforeShareRef.current = localStreamRef.current?.getVideoTracks()[0] ?? null;
    sharingRef.current = true;
    setIsScreenSharing(true);
    // The browser's own "Stop sharing" button ends the track — revert to
    // camera through the same path as our in-app toggle.
    screenTrack.onended = () => {
      void stopScreenShare(true);
    };
    try {
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      } else {
        // Audio call (or audio-only fallback): no video sender exists yet —
        // add one; this is the case that needs renegotiation.
        addedVideoSenderRef.current = pc.addTrack(screenTrack, screenStream);
        await renegotiateForTrackChange();
      }
    } catch (err) {
      console.warn('Could not start screen share:', err);
      void stopScreenShare();
      return;
    }
    // Local preview: video calls reuse the PiP element (wired by the
    // isScreenSharing effect below); audio calls get a dedicated preview.
    if (localVideoRef.current && effectiveCallType === 'video') {
      localVideoRef.current.srcObject = screenStream;
      localVideoRef.current.play().catch(() => {});
    }
  }, [effectiveCallType, renegotiateForTrackChange, screenShareSupported, stopScreenShare]);

  // Audio-call screen preview wiring (the element only mounts while sharing).
  useEffect(() => {
    if (isScreenSharing && screenPreviewRef.current && screenStreamRef.current) {
      screenPreviewRef.current.srcObject = screenStreamRef.current;
      screenPreviewRef.current.play().catch(() => {});
    }
  }, [isScreenSharing]);

  // Audio-call remote screen wiring: the display-only element mounts only
  // after ontrack flips hasRemoteVideo, so attach the stored stream here.
  useEffect(() => {
    if (
      effectiveCallType === 'audio' &&
      hasRemoteVideo &&
      remoteVideoRef.current &&
      remoteStreamRef.current
    ) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [hasRemoteVideo, effectiveCallType]);

  // ── Connecting timeout (0.7) ───────────────────────────────────────────────
  // If the peer connection has not reached 'connected' within ~20s of call
  // start / accept, surface a visible failure and tear down cleanly
  // (finishAndClose sends 'end', closes the pc and resets the UI via onClose).
  const startConnectingTimeout = useCallback(() => {
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = setTimeout(() => {
      connectTimeoutRef.current = null;
      if (!connectedRef.current && !endedRef.current) {
        setFailureMessage(lang === 'bn' ? 'সংযোগ করা যায়নি — আবার চেষ্টা করুন' : "Couldn't connect — please try again");
        finishAndClose(true, 'failed', 'ended');
      }
    }, 20000);
  }, [finishAndClose, lang]);

  const createPeer = useCallback(async (): Promise<RTCPeerConnection | null> => {
    if (pcRef.current) return pcRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: effectiveCallType === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: facingModeRef.current } : false,
      });
    } catch (err) {
      // Video calls: fall back to audio-only if the camera is unavailable so
      // the call still connects (voice beats no call at all).
      if (effectiveCallType === 'video') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          setMediaNote(lang === 'bn' ? 'ক্যামেরা পাওয়া যায়নি — শুধু ভয়েস' : 'Camera unavailable — voice only');
          setIsVideoEnabled(false);
        } catch (err2) {
          console.warn('Could not acquire local media:', err2);
          mediaFailedRef.current = true;
          setMediaError(lang === 'bn' ? 'ক্যামেরা/মাইক্রোফোন পাওয়া যায়নি — পারমিশন দিন' : 'Camera/microphone unavailable — check permission');
          return null;
        }
      } else {
        console.warn('Could not acquire local media:', err);
        mediaFailedRef.current = true;
        setMediaError(lang === 'bn' ? 'ক্যামেরা/মাইক্রোফোন পাওয়া যায়নি — পারমিশন দিন' : 'Camera/microphone unavailable — check permission');
        return null;
      }
    }
    localStreamRef.current = stream;
    setHasVideoTrack(stream.getVideoTracks().length > 0);
    // Only attach preview when there is an actual video track (fallback streams have none).
    if (localVideoRef.current && effectiveCallType === 'video' && stream.getVideoTracks().length > 0) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.play().catch(() => {});
    }

    const iceServers = await getIceServers();
    if (endedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      if (localStreamRef.current === stream) localStreamRef.current = null;
      return null;
    }
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketService.sendCallSignal({
          signalType: 'ice-candidate',
          targetUserId: peerId,
          roomId,
          signal: e.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (e) => {
      const streamObj = e.streams[0] ?? new MediaStream([e.track]);
      // Phase 1.3: a video track arriving during an audio call is the
      // peer's screen share — surface the display-only remote element.
      if (e.track.kind === 'video') {
        setHasRemoteVideo(true);
        e.track.onended = () => {
          if (pcRef.current) {
            const stillHas = pcRef.current
              .getReceivers()
              .some((r) => r.track?.kind === 'video' && r.track.readyState === 'live');
            setHasRemoteVideo(stillHas);
          }
        };
      }
      attachRemoteStream(streamObj);
    };

    // ICE restart flow (0.7): restartIce() marks negotiation as needed, which
    // fires onnegotiationneeded; that handler drives the renegotiation. The
    // flag keeps this handler scoped to restarts ONLY — initial offers are
    // created explicitly by the accept/offer signalling handlers and must
    // not be duplicated from here.
    pc.onnegotiationneeded = () => {
      if (!iceRestartNeededRef.current) return;
      void renegotiateIceRestart();
    };

    const requestIceRestart = () => {
      iceRestartNeededRef.current = true;
      try {
        pc.restartIce();
      } catch {
        /* ignore */
      }
      // Belt-and-braces: also drive renegotiation directly in case the
      // browser does not surface a negotiationneeded event for restartIce().
      // renegotiateIceRestart() consumes the flag and is in-flight guarded,
      // so the two paths cannot produce duplicate offers.
      void renegotiateIceRestart();
    };

    pc.oniceconnectionstatechange = () => {
      if (pcRef.current !== pc || endedRef.current) return;
      const iceState = pc.iceConnectionState;
      if (iceState === 'failed') {
        if (iceDisconnectedTimerRef.current) {
          clearTimeout(iceDisconnectedTimerRef.current);
          iceDisconnectedTimerRef.current = null;
        }
        requestIceRestart();
      } else if (iceState === 'disconnected') {
        // Transient in most networks — wait ~3s before restarting, and only
        // if the connection is still disconnected when the timer fires.
        if (iceDisconnectedTimerRef.current) clearTimeout(iceDisconnectedTimerRef.current);
        iceDisconnectedTimerRef.current = setTimeout(() => {
          iceDisconnectedTimerRef.current = null;
          if (pcRef.current === pc && pc.iceConnectionState === 'disconnected' && !endedRef.current) {
            requestIceRestart();
          }
        }, 3000);
      } else if (iceState === 'connected' || iceState === 'completed') {
        if (iceDisconnectedTimerRef.current) {
          clearTimeout(iceDisconnectedTimerRef.current);
          iceDisconnectedTimerRef.current = null;
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        connectedRef.current = true;
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        if (iceDisconnectedTimerRef.current) {
          clearTimeout(iceDisconnectedTimerRef.current);
          iceDisconnectedTimerRef.current = null;
        }
        setStatus('connected');
      }
    };
    return pc;
  }, [attachRemoteStream, effectiveCallType, lang, peerId, roomId, renegotiateIceRestart]);

  // ── Session lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    endedRef.current = false;
    endReasonRef.current = 'ended';
    facingModeRef.current = 'user';
    acceptedRef.current = direction === 'out';
    connectedRef.current = false;
    mediaFailedRef.current = false;
    iceRestartInFlightRef.current = false;
    iceRestartNeededRef.current = false;
    durationRef.current = 0;
    setCallDuration(0);
    setIsMuted(false);
    setIsVideoEnabled(effectiveCallType === 'video');
    setMediaError(null);
    setFailureMessage(null);
    setMediaNote(null);
    setHasVideoTrack(false);
    setNeedsTapForSound(false);
    setIsScreenSharing(false);
    setCallQuality(null);
    setIsMinimized(false);
    setTilePos(null);
    dataBytesRef.current = null;
    tileDragRef.current = null;
    tileDragMovedRef.current = false;
    setHasRemoteVideo(false);
    sharingRef.current = false;
    screenStreamRef.current = null;
    screenTrackRef.current = null;
    cameraTrackBeforeShareRef.current = null;
    addedVideoSenderRef.current = null;
    prevInboundRef.current = null;
    weakStreakRef.current = 0;
    setStatus(direction === 'in' ? 'ringing' : 'calling');

    if (direction === 'out') {
      // Phase 1.3 regression guard (redial rings ONLY the intended peer):
      // an outgoing session without a peerId must never send an invite —
      // untargeted signals fall back to a room-scoped relay on the server.
      // (App disables group calls since 0.7, so this is unreachable in the
      // shipped UI; the guard keeps it that way at the source.)
      if (!peerId) {
        mediaFailedRef.current = true;
        setFailureMessage(lang === 'bn' ? 'প্রাপক পাওয়া যায়নি' : 'No recipient for this call');
        setStatus('failed');
        return;
      }
      // NOTE (coordinator): the 1:1 invite is sent HERE, in this modal's
      // session effect — App.tsx only sets the CallSession and opens the
      // modal. So the media-failure guard below fully covers the invite.
      createPeer().then((pc) => {
        if (endedRef.current) return;
        if (!pc) {
          // Media-failure guard (0.7): local media acquisition failed —
          // do NOT send the invite; surface the failure state instead.
          setStatus('failed');
          return;
        }
        socketService.sendCallSignal({
          signalType: 'invite',
          targetUserId: peerId,
          roomId,
          signal: { callType: effectiveCallType, fromName: currentUser.name, fromId: currentUser.id },
        });
        startConnectingTimeout();
      });
      const noAnswer = setTimeout(() => {
        if (!connectedRef.current && !endedRef.current) finishAndClose(true, 'no-answer', 'no-answer');
      }, 30000);
      return () => {
        clearTimeout(noAnswer);
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
      };
    }
    // Incoming: wait for Accept before touching media devices.
    // Callee ring timeout — an unanswered ring becomes a missed call after 45s.
    const ringTimeout = setTimeout(() => {
      if (!acceptedRef.current && !connectedRef.current && !endedRef.current) {
        finishAndClose(false, 'ended', 'no-answer');
      }
    }, 45000);
    return () => clearTimeout(ringTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, session]);

  // Ringtone + vibration while an incoming call is ringing.
  useEffect(() => {
    if (isOpen && direction === 'in' && status === 'ringing' && isRingtoneEnabled()) {
      startRingtone();
      try {
        navigator.vibrate?.([500, 300, 500, 300, 500]);
      } catch {
        /* vibration unsupported */
      }
      return () => stopRingtone();
    }
    return undefined;
  }, [isOpen, status, direction]);

  // Duration timer — runs only while truly connected
  useEffect(() => {
    if (status !== 'connected') return;
    const t = setInterval(() => {
      durationRef.current += 1;
      setCallDuration(durationRef.current);
    }, 1000);
    return () => clearInterval(t);
  }, [status]);

  // Call quality + data-used (1.3, extended Mega Round): poll RTC stats
  // every 2s while connected. One poll drives BOTH outputs:
  //  • quality bars — candidate-pair RTT + packetsLost delta per poll
  //    (remote-inbound-rtp fractionLost is the fallback loss signal);
  //  • honest data-used — the LATEST cumulative bytesReceived
  //    (inbound-rtp) + bytesSent (outbound-rtp) total, read at call end
  //    by finishAndClose. Never estimated; absent if stats never ran.
  // This single indicator replaces the old weak-connection badge — the
  // two signals are merged here, not duplicated in the UI.
  // The interval is torn down when the call leaves the connected state,
  // when the modal closes, and again in cleanup().
  useEffect(() => {
    if (!isOpen || status !== 'connected') {
      setCallQuality(null);
      weakStreakRef.current = 0;
      prevInboundRef.current = null;
      return;
    }
    const pc = pcRef.current;
    if (!pc || typeof pc.getStats !== 'function') return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || endedRef.current || pcRef.current !== pc) return;
      try {
        const stats = await pc.getStats();
        if (cancelled || endedRef.current || pcRef.current !== pc) return;
        let rtt: number | null = null;
        let received = 0;
        let lost = 0;
        let hasInbound = false;
        let fractionLost: number | null = null;
        let bytesTotal = 0;
        let hasBytes = false;
        stats.forEach((report) => {
          const r = report as any;
          if (
            r.type === 'candidate-pair' &&
            (r.state === 'succeeded' || r.nominated === true) &&
            typeof r.currentRoundTripTime === 'number'
          ) {
            rtt = Math.max(rtt ?? 0, r.currentRoundTripTime as number);
          } else if (r.type === 'inbound-rtp') {
            // Sum audio+video inbound counters for the interval loss rate.
            if (typeof r.packetsReceived === 'number') received += r.packetsReceived;
            if (typeof r.packetsLost === 'number') lost += r.packetsLost;
            if (typeof r.bytesReceived === 'number') {
              bytesTotal += r.bytesReceived;
              hasBytes = true;
            }
            hasInbound = true;
          } else if (r.type === 'outbound-rtp') {
            if (typeof r.bytesSent === 'number') {
              bytesTotal += r.bytesSent;
              hasBytes = true;
            }
          }
          if (r.type === 'remote-inbound-rtp' && typeof r.fractionLost === 'number') {
            fractionLost = Math.max(fractionLost ?? 0, r.fractionLost as number);
          }
        });
        if (hasBytes) dataBytesRef.current = bytesTotal;
        let lossRate: number | null = null;
        let lostDelta: number | null = null;
        if (hasInbound) {
          const prev = prevInboundRef.current;
          prevInboundRef.current = { received, lost };
          if (prev) {
            const dReceived = received - prev.received;
            const dLost = Math.max(0, lost - prev.lost);
            lostDelta = dLost;
            const total = dReceived + dLost;
            if (total > 0) lossRate = dLost / total;
          }
        }
        if (lossRate === null && fractionLost !== null) lossRate = fractionLost;
        // Quality: 3 = RTT <150ms and no loss growth; 2 = RTT <300ms or
        // slight loss; 1 = anything worse. No signal → leave as-is.
        if (rtt !== null || lossRate !== null || lostDelta !== null) {
          const rttMs = rtt !== null ? rtt * 1000 : null;
          const noLoss = (lostDelta === null || lostDelta === 0) && (lossRate === null || lossRate === 0);
          let quality: 1 | 2 | 3;
          if (rttMs !== null && rttMs < 150 && noLoss) quality = 3;
          else if (rttMs !== null && rttMs < 300 && (lossRate === null || lossRate <= 0.08)) quality = 2;
          else if (rttMs === null && lossRate !== null && lossRate <= 0.08) quality = 2;
          else quality = 1;
          // A single 1-bar spike must persist for 2 polls before the
          // "Poor connection" label shows (ex-weak-badge streak rule);
          // recovery/improvement is reflected immediately.
          if (quality === 1) {
            weakStreakRef.current += 1;
            setCallQuality(weakStreakRef.current >= 2 ? 1 : 2);
          } else {
            weakStreakRef.current = 0;
            setCallQuality(quality);
          }
        }
      } catch {
        /* getStats is best-effort — a failed poll just skips this round */
      }
    };
    void tick();
    const interval = setInterval(() => {
      void tick();
    }, 2000);
    statsIntervalRef.current = interval;
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (statsIntervalRef.current === interval) statsIntervalRef.current = null;
    };
  }, [isOpen, status]);

  // ── Signaling ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const unsub = socketService.onCallSignal(async (data) => {
      if (endedRef.current) return;
      if (data.targetUserId && data.targetUserId !== currentUser.id) return;
      if (data.fromUserId && peerId && data.fromUserId !== peerId) return;

      switch (data.signalType) {
        case 'accept': {
          if (direction !== 'out') return;
          setStatus('connecting');
          const pc = await createPeer();
          if (!pc) {
            // Media failed — never send the offer; show the failure state.
            setStatus('failed');
            return;
          }
          startConnectingTimeout();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketService.sendCallSignal({ signalType: 'offer', targetUserId: peerId, roomId, signal: offer });
          break;
        }
        case 'offer': {
          // Initial offer (callee side) AND ICE-restart offers (either side —
          // the caller must also be able to answer a restart offer from the
          // callee). acceptedRef is true for outgoing sessions from the
          // start and for incoming sessions once the user taps Accept, so
          // this guard still rejects offers for a call not yet accepted.
          if (!acceptedRef.current) return;
          setStatus('connecting');
          const pc = await createPeer();
          if (!pc) {
            // Media failed — never send the answer; show the failure state.
            setStatus('failed');
            return;
          }
          // Glare guard: both sides restarted ICE at once and we already
          // have a local offer outstanding. Deterministic resolution: the
          // incoming side (direction 'in') is impolite and ignores the
          // colliding offer; the outgoing side rolls its own offer back
          // and answers the peer's.
          if (pc.signalingState === 'have-local-offer') {
            if (direction === 'in') return;
            try {
              await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
            } catch {
              return;
            }
          }
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.signal));
          } catch (err) {
            console.warn('Failed to apply remote offer:', err);
            return;
          }
          remoteReadyRef.current = true;
          for (const c of pendingIceRef.current) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* ignore */
            }
          }
          pendingIceRef.current = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketService.sendCallSignal({ signalType: 'answer', targetUserId: peerId, roomId, signal: answer });
          break;
        }
        case 'answer': {
          const pc = pcRef.current;
          if (!pc) return;
          // An answer is only valid while our offer is outstanding. In an
          // ICE-restart glare the polite side rolled its offer back, so a
          // late answer to it must be ignored, not applied (applying it in
          // 'stable' state throws).
          if (pc.signalingState !== 'have-local-offer') return;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.signal));
          } catch (err) {
            console.warn('Failed to apply remote answer:', err);
            return;
          }
          remoteReadyRef.current = true;
          for (const c of pendingIceRef.current) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* ignore */
            }
          }
          pendingIceRef.current = [];
          break;
        }
        case 'ice-candidate': {
          const pc = pcRef.current;
          if (pc && remoteReadyRef.current && pc.remoteDescription) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.signal));
            } catch {
              /* ignore */
            }
          } else {
            pendingIceRef.current.push(data.signal);
          }
          break;
        }
        case 'busy': {
          // Peer is already in another call — tell the caller, don't log as a plain end.
          if (direction === 'out' && !connectedRef.current) {
            setStatus('busy');
            finishAndClose(false, 'busy', 'busy');
          }
          break;
        }
        case 'reject': {
          if (!connectedRef.current) {
            setStatus('declined');
            finishAndClose(false, 'declined', 'declined');
          } else {
            finishAndClose(false, 'ended', 'ended');
          }
          break;
        }
        case 'end': {
          finishAndClose(false, 'ended', 'ended');
          break;
        }
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, session]);

  const handleAccept = async () => {
    acceptedRef.current = true;
    setStatus('connecting');
    const pc = await createPeer();
    if (!pc) {
      // Media-failure guard (0.7): local media acquisition failed — do NOT
      // send the accept signal; surface the failure state instead (the
      // caller simply sees no answer and their own timeout ends the ring).
      setStatus('failed');
      return;
    }
    socketService.sendCallSignal({ signalType: 'accept', targetUserId: peerId, roomId });
    startConnectingTimeout();
  };

  const handleDecline = () => {
    socketService.sendCallSignal({ signalType: 'reject', targetUserId: peerId, roomId });
    // Callee's own log also records 'declined' (not a generic end).
    finishAndClose(false, 'ended', 'declined');
  };

  const handleFlipCamera = async () => {
    // Swap the video track in-place via replaceTrack so the call never drops.
    // Phase 1.3 regression fix: while screen-sharing, the video sender
    // carries the DISPLAY track — flipping would replace the share with a
    // camera track and corrupt the share bookkeeping, so it is a no-op.
    if (sharingRef.current) return;
    try {
      const pc = pcRef.current;
      const localStream = localStreamRef.current;
      if (!pc || !localStream) return;
      const newMode: 'user' | 'environment' = facingModeRef.current === 'user' ? 'environment' : 'user';
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newMode, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Phase 1.3 regression fix: a freshly acquired track defaults to
      // enabled — if the user had their camera OFF, the flipped camera
      // must stay off, not silently turn back on.
      newTrack.enabled = isVideoEnabled;
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }
      const oldTrack = localStream.getVideoTracks()[0];
      await sender.replaceTrack(newTrack);
      facingModeRef.current = newMode;
      if (oldTrack) {
        oldTrack.stop();
        localStream.removeTrack(oldTrack);
      }
      localStream.addTrack(newTrack);
      // Stop any extra tracks from the temp stream container.
      newStream.getTracks().forEach((t) => {
        if (t !== newTrack) t.stop();
      });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
        localVideoRef.current.play().catch(() => {});
      }
      setHasVideoTrack(true);
    } catch {
      // Desktop browsers often have a single camera — failure is a silent no-op.
    }
  };

  const handleToggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = isMuted;
      });
    }
    setIsMuted(!isMuted);
  };

  const handleToggleVideo = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !isVideoEnabled;
      });
    }
    setIsVideoEnabled(!isVideoEnabled);
  };

  const handleToggleSpeaker = async () => {
    const next = !isSpeakerOn;
    setIsSpeakerOn(next);
    // ECHO FIX companion (0.7): the toggle must route the element that
    // ACTUALLY carries remote audio — the <video> element in video calls,
    // the <audio> element in audio calls. (It previously picked the <audio>
    // element first in every call, which was the wrong — duplicate —
    // element during video calls.)
    const el: any = effectiveCallType === 'video' ? remoteVideoRef.current : remoteAudioRef.current;
    if (!el) return;
    let routed = false;
    if (typeof el.setSinkId === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d: MediaDeviceInfo) => d.kind === 'audiooutput');
        const target = next ? outputs[0] : outputs.find((d: MediaDeviceInfo) => /earpiece|receiver|phone/i.test(d.label)) || outputs[0];
        if (target) {
          await el.setSinkId(target.deviceId);
          routed = true;
        }
      } catch {
        /* fall through to the volume path below */
      }
    }
    if (routed) {
      el.volume = 1;
      el.muted = false;
    } else {
      // No output-device routing available on this browser: the toggle
      // honestly drives the audible element itself — full volume on
      // speaker, quiet earpiece-level volume off speaker.
      el.volume = next ? 1 : 0.25;
      el.muted = false;
    }
  };

  const handleEndCall = () => finishAndClose(true, 'ended');

  // ── Minimize / PiP tile (Mega Round) ─────────────────────────────────────
  // SAFER ROUTE CHOSEN: CSS re-layout of the SAME modal tree. Nothing is
  // unmounted or remounted — non-essential sections get the `hidden`
  // class, the remote/local <video> elements and the always-mounted
  // remote <audio> stay exactly where they are (same refs, same
  // srcObject), so the PC and streams survive minimize/restore untouched.
  const handleTilePointerDown = (e: React.PointerEvent) => {
    if (!isMinimized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = tileOuterRef.current?.getBoundingClientRect();
    if (!rect) return;
    tileDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    tileDragMovedRef.current = false;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported — drag still works via move events */
    }
  };
  const handleTilePointerMove = (e: React.PointerEvent) => {
    const drag = tileDragRef.current;
    if (!drag || !isMinimized || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) tileDragMovedRef.current = true;
    const maxX = Math.max(8, window.innerWidth - 184);
    const maxY = Math.max(8, window.innerHeight - 168);
    setTilePos({
      x: Math.min(maxX, Math.max(8, drag.origX + dx)),
      y: Math.min(maxY, Math.max(8, drag.origY + dy)),
    });
  };
  const handleTilePointerUp = (e: React.PointerEvent) => {
    if (tileDragRef.current?.pointerId === e.pointerId) tileDragRef.current = null;
  };
  const handleTileClick = () => {
    if (!isMinimized) return;
    // A drag ends with a click too — only a genuine tap restores.
    if (tileDragMovedRef.current) {
      tileDragMovedRef.current = false;
      return;
    }
    setIsMinimized(false);
  };

  if (!isOpen) return null;

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const displayName = peerName;
  // No target user (e.g. a room call) → initials avatar from the display
  // name. Never substitute a stock photo of a stranger.
  const displayAvatar = targetUser ? targetUser.avatar : null;
  const displayInitials =
    displayName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('') || '?';

  const statusText =
    status === 'ringing'
      ? lang === 'bn'
        ? 'ইনকামিং কল...'
        : 'Incoming call...'
      : status === 'calling'
      ? lang === 'bn'
        ? 'কল হচ্ছে... পিয়ারের অপেক্ষায়'
        : 'Calling... waiting for peer'
      : status === 'connecting'
      ? lang === 'bn'
        ? 'সংযোগ হচ্ছে...'
        : 'Connecting...'
      : status === 'failed'
      ? failureMessage ??
        (lang === 'bn' ? 'ক্যামেরা/মাইক্রোফোন পাওয়া যায়নি' : 'Camera/microphone unavailable')
      : status === 'no-answer'
      ? lang === 'bn'
        ? 'কোনো উত্তর নেই'
        : 'No answer'
      : status === 'busy'
      ? lang === 'bn'
        ? 'ব্যস্ত — অন্য কলে আছেন'
        : 'Busy — on another call'
      : status === 'declined'
      ? lang === 'bn'
        ? 'কল প্রত্যাখ্যান করা হয়েছে'
        : 'Call declined'
      : status === 'ended'
      ? lang === 'bn'
        ? 'কল শেষ'
        : 'Call ended'
      : effectiveCallType === 'video'
      ? lang === 'bn'
        ? 'ভিডিও কল সংযুক্ত'
        : 'Video Call Connected'
      : lang === 'bn'
      ? 'ভয়েস কল সংযুক্ত'
      : 'Voice Call Connected';

  // Presentational only: incoming-ringing and audio calls use a SOLID
  // deep-emerald surface (#095C42, Mega Round palette — solids only);
  // video calls use the dark surface #0C1210. No state/logic derives
  // from these — they only pick container classes in the JSX below.
  const isIncomingRinging = status === 'ringing' && direction === 'in';
  const useSolidSurface = isIncomingRinging || effectiveCallType === 'audio';
  const qualityBarColor = callQuality === 3 ? '#0B6E4F' : callQuality === 2 ? '#F2A007' : '#E5484D';

  return (
    <div
      ref={tileOuterRef}
      className={
        isMinimized
          ? 'fixed z-40 w-[176px] rounded-2xl shadow-2xl overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing'
          : 'fixed inset-0 z-50 animate-in fade-in select-none'
      }
      style={
        isMinimized
          ? tilePos
            ? { left: tilePos.x, top: tilePos.y }
            : { right: 16, bottom: 96 }
          : undefined
      }
      onPointerDown={handleTilePointerDown}
      onPointerMove={handleTilePointerMove}
      onPointerUp={handleTilePointerUp}
      onPointerCancel={handleTilePointerUp}
      onClick={handleTileClick}
      role="dialog"
      aria-modal={isMinimized ? undefined : 'true'}
      aria-label={`Call with ${displayName}`}
    >
      {/* Dedicated remote-audio player — ALWAYS mounted so audio calls can produce sound */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className={`flex flex-col items-center text-center relative overflow-hidden ${isMinimized ? (effectiveCallType === 'video' ? 'w-[176px] h-auto' : 'w-[176px] h-[176px]') : 'w-full h-full px-5 pt-5 animate-in zoom-in-95 duration-[var(--dur-sheet)] ease-[var(--ease-spring)]'} ${useSolidSurface ? 'bg-[#095C42] text-white' : 'bg-[#0C1210] text-white'}`}>
        <div className={`absolute -top-24 -left-24 w-48 h-48 bg-white/10 rounded-full blur-3xl pointer-events-none ${isMinimized ? 'hidden' : ''}`} />
        <div className={`absolute -bottom-24 -right-24 w-48 h-48 bg-white/10 rounded-full blur-3xl pointer-events-none ${isMinimized ? 'hidden' : ''}`} />

        {/* Top Header — CSS-hidden (not unmounted) while minimized */}
        <div className={`w-full max-w-2xl flex items-center justify-between pb-3 text-xs relative ${isMinimized ? 'hidden' : ''}`}>
          <div className="flex items-center gap-1.5 text-white/80 font-semibold">
            <ShieldCheck className="w-4 h-4" />
            <span>{lang === 'bn' ? 'WebRTC · এনক্রিপ্টেড (DTLS-SRTP)' : 'WebRTC · Encrypted (DTLS-SRTP)'}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* No fabricated quality claim: the old static 'HD' label is
                gone — real quality lives in the stats-driven bars in the
                control bar below. This badge only names the call kind. */}
            <span className="text-[10px] font-mono bg-white/20 text-white px-2 py-0.5 rounded-full">
              {effectiveCallType === 'video' ? (lang === 'bn' ? 'ভিডিও' : 'Video') : (lang === 'bn' ? 'অডিও' : 'Audio')}
            </span>
            {status !== 'ringing' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMinimized(true);
                }}
                className="w-11 h-11 shrink-0 flex items-center justify-center text-white/70 hover:text-white rounded-full"
                aria-label={lang === 'bn' ? 'ছোট করুন' : 'Minimize call'}
                title={lang === 'bn' ? 'ছোট করুন' : 'Minimize call'}
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            )}
            <button onClick={handleEndCall} className="w-11 h-11 shrink-0 flex items-center justify-center text-white/70 hover:text-white rounded-full" aria-label={lang === 'bn' ? 'কল শেষ করুন' : 'End call'} >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Status — white on solid/video for contrast in every state.
            CSS-hidden while minimized (the tile bar shows the timer). */}
        <div className={`flex items-center gap-2 text-xs text-white/80 my-4 font-mono font-medium relative ${isMinimized ? 'hidden' : ''}`}>
          <span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-[#1FA855]' : 'bg-white animate-ping'}`} />
          <span>{statusText}</span>
          {status === 'connected' && <span className="text-white/70">· {formatTimer(callDuration)}</span>}
          {isScreenSharing && status === 'connected' && (
            <span className="flex items-center gap-1 text-[10px] font-bold bg-white/20 text-white px-2 py-0.5 rounded-full">
              <ScreenShare className="w-3 h-3" />
              {lang === 'bn' ? 'স্ক্রিন শেয়ার হচ্ছে' : 'Sharing screen'}
            </span>
          )}
        </div>

        {mediaError && (
          <div className={`mb-3 px-3 py-2 rounded-xl bg-app border border-token text-danger text-xs font-semibold relative ${isMinimized ? 'hidden' : ''}`}>
            {mediaError}
          </div>
        )}

        {status === 'failed' && failureMessage && !mediaError && (
          <div className={`mb-3 px-3 py-2 rounded-xl bg-app border border-token text-danger text-xs font-semibold relative ${isMinimized ? 'hidden' : ''}`}>
            {failureMessage}
          </div>
        )}

        {mediaNote && (
          <div className={`mb-3 px-3 py-2 rounded-xl bg-app border border-token text-app-2 text-xs font-semibold relative ${isMinimized ? 'hidden' : ''}`}>
            {mediaNote}
          </div>
        )}

        {/* VIDEO MODE: remote (big) + local PiP — both ALWAYS mounted during video calls.
            In the minimized tile this same container just shrinks — the
            remote <video> element itself is never remounted. */}
        {effectiveCallType === 'video' ? (
          <div className={isMinimized ? 'w-full aspect-video bg-[#0C1210] overflow-hidden relative' : 'w-full max-w-2xl aspect-video bg-[#0C1210] rounded-[var(--r-card)] overflow-hidden relative mb-4 shadow-soft'}>
            <video ref={remoteVideoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover" />
            {status !== 'connected' && (
              <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 ${isMinimized ? 'hidden' : ''}`}>
                {displayAvatar ? (
                  <img src={displayAvatar} alt={displayName} className="w-20 h-20 rounded-full object-cover ring-4 ring-white/40" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-white/20 text-white flex items-center justify-center text-2xl font-bold ring-4 ring-white/40">
                    {displayInitials}
                  </div>
                )}
                <span className="text-white text-2xl font-bold">{displayName}</span>
                <span className="text-white/80 text-xs">{statusText}</span>
              </div>
            )}
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`absolute bottom-2 right-2 w-24 aspect-video object-cover rounded-[var(--r-card)] ring-2 ring-white/60 shadow-soft bg-[#0C1210] ${isVideoEnabled ? '' : 'opacity-40'} ${isMinimized ? 'hidden' : ''}`}
            />
          </div>
        ) : (
          <>
            {/* Hidden local video element keeps the ref valid for audio-only sessions */}
            <video ref={localVideoRef} autoPlay playsInline muted className="hidden" />
            {/* Phase 1.3: peer's screen share during an audio call — muted
                and display-only; remote audio stays on the <audio> element
                alone (see attachRemoteStream). */}
            {hasRemoteVideo && (
              <div className={`relative ${isMinimized ? 'w-full' : 'w-full max-w-2xl mb-4'}`}>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full aspect-video bg-[#0C1210] object-contain ${isMinimized ? '' : 'rounded-[var(--r-card)] shadow-soft'}`}
                />
                <span className="absolute top-2 left-2 text-[10px] font-bold bg-black/60 text-white px-2 py-0.5 rounded-full">
                  {lang === 'bn' ? 'শেয়ার করা স্ক্রিন' : 'Shared screen'}
                </span>
              </div>
            )}
            {/* Phase 1.3: own screen-share preview during an audio call. */}
            {isScreenSharing && (
              <div className={`w-full max-w-2xl relative mb-4 ${isMinimized ? 'hidden' : ''}`}>
                <video
                  ref={screenPreviewRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full aspect-video bg-[#0C1210] rounded-[var(--r-card)] object-contain shadow-soft ring-2 ring-white/50"
                />
                <span className="absolute top-2 left-2 text-[10px] font-bold bg-black/60 text-white px-2 py-0.5 rounded-full">
                  {lang === 'bn' ? 'আপনি শেয়ার করছেন' : 'You are sharing'}
                </span>
              </div>
            )}
            <div className="flex-1 flex flex-col items-center justify-center relative">
              <div className={`relative ${isMinimized ? 'mb-2' : 'mb-4'}`}>
                {displayAvatar ? (
                  <img src={displayAvatar} alt={displayName} className={`rounded-full object-cover ring-4 ring-white/40 shadow-soft ${isMinimized ? 'w-16 h-16' : 'w-32 h-32'}`} />
                ) : (
                  <div className={`rounded-full bg-white/20 text-white flex items-center justify-center font-bold ring-4 ring-white/40 shadow-soft ${isMinimized ? 'w-16 h-16 text-xl' : 'w-32 h-32 text-4xl'}`}>
                    {displayInitials}
                  </div>
                )}
                {(status === 'calling' || status === 'ringing') && (
                  <span className="absolute inset-0 rounded-full ring-4 ring-white/40 animate-ping" />
                )}
              </div>
              <h3 className={`font-bold text-white ${isMinimized ? 'text-sm px-2 truncate max-w-full' : 'text-2xl'}`}>{displayName}</h3>
              <p className={`text-white/80 ${isMinimized ? 'hidden' : 'text-sm mt-1'}`}>
                {status === 'connected'
                  ? formatTimer(callDuration)
                  : (lang === 'bn' ? 'ভয়েস কল' : 'Voice call')}
              </p>
              <p className={`text-xs text-white/70 mt-0.5 ${isMinimized ? 'hidden' : ''}`}>{statusText}</p>
            </div>
          </>
        )}

        {needsTapForSound && status === 'connected' && (
          <button
            onClick={() => {
              // Play only the single audible element (see attachRemoteStream).
              const audibleEl = effectiveCallType === 'video' ? remoteVideoRef.current : remoteAudioRef.current;
              audibleEl?.play().catch(() => {});
              setNeedsTapForSound(false);
            }}
            className={`mb-3 px-4 py-2 rounded-full bg-[#0B6E4F] text-white hover:opacity-90 text-xs font-bold shadow-md animate-pulse ${isMinimized ? 'hidden' : ''}`}
          >
            🔊 {lang === 'bn' ? 'সাউন্ডের জন্য ট্যাপ করুন' : 'Tap for sound'}
          </button>
        )}

        <p className={`mt-4 text-[10px] text-white/70 leading-relaxed relative max-w-sm ${isMinimized ? 'hidden' : ''}`}>
          {lang === 'bn'
            ? 'আসল WebRTC কল — অন্য ডিভাইস/ট্যাব থেকে পিয়ার জয়েন করলে সংযোগ হবে। কেউ না ধরলে ৩০ সেকেন্ডে মিসড কল হবে।'
            : 'Real WebRTC call — the peer joins from another device/tab in this app. No answer in 30s becomes a missed call.'}
        </p>

        {/* Controls */}
        {status === 'ringing' && direction === 'in' ? (
          <div className={`glass-pill flex items-center gap-8 mt-auto mb-10 relative px-6 py-4 transition-transform duration-[var(--dur-sheet)] ease-[var(--ease-spring)] ${isMinimized ? 'hidden' : ''}`}>
            <button
              onClick={handleDecline}
              className="w-[72px] h-[72px] rounded-full bg-[#E5484D] hover:opacity-90 text-white flex items-center justify-center shadow-soft transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95"
              title={lang === 'bn' ? 'রিজেক্ট' : 'Decline'} aria-label={lang === 'bn' ? 'রিজেক্ট' : 'Decline'}
            >
              {/* lucide-react 0.546 (pinned) has no PhoneDown export — a handset rotated 135° is the same decline glyph */}
              <Phone className="w-7 h-7 rotate-[135deg]" />
            </button>
            <button
              onClick={handleAccept}
              className="w-[72px] h-[72px] rounded-full bg-[#1FA855] hover:opacity-90 text-white flex items-center justify-center shadow-soft transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 animate-pulse"
              title={lang === 'bn' ? 'ধরুন' : 'Accept'} aria-label={lang === 'bn' ? 'ধরুন' : 'Accept'}
            >
              <Phone className="w-7 h-7" />
            </button>
          </div>
        ) : (
          <div className={`glass-pill mx-4 mb-6 flex flex-wrap items-center justify-center gap-3 px-4 py-3 mt-auto relative w-[calc(100%-2rem)] max-w-md transition-transform duration-[var(--dur-sheet)] ease-[var(--ease-spring)] ${isMinimized ? 'hidden' : ''}`}>
            {/* Call-quality indicator (Mega Round): 3 stats-driven bars
                in the control bar. Emerald = good, amber = fair, red =
                poor (+ 'Poor connection' label at 1 bar). This is the
                single merged quality signal — no separate weak badge. */}
            {status === 'connected' && callQuality !== null && (
              <div
                className="flex items-center gap-1.5 shrink-0 pr-1"
                role="status"
                aria-label={callQuality === 1 ? (lang === 'bn' ? 'সংযোগ দুর্বল' : 'Poor connection') : callQuality === 2 ? (lang === 'bn' ? 'সংযোগ মোটামুটি' : 'Fair connection') : (lang === 'bn' ? 'সংযোগ ভালো' : 'Good connection')}
                title={callQuality === 1 ? (lang === 'bn' ? 'সংযোগ দুর্বল' : 'Poor connection') : callQuality === 2 ? (lang === 'bn' ? 'সংযোগ মোটামুটি' : 'Fair connection') : (lang === 'bn' ? 'সংযোগ ভালো' : 'Good connection')}
              >
                <span className="flex items-end gap-[3px] h-[14px]" aria-hidden="true">
                  {[6, 10, 14].map((h, i) => (
                    <span
                      key={h}
                      className="w-[3px] rounded-full"
                      style={{ height: h, backgroundColor: i < callQuality ? qualityBarColor : 'rgba(21,33,27,0.22)' }}
                    />
                  ))}
                </span>
                {callQuality === 1 && (
                  <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: '#E5484D' }}>
                    {lang === 'bn' ? 'সংযোগ দুর্বল' : 'Poor connection'}
                  </span>
                )}
              </div>
            )}
            <button
              onClick={handleToggleMute}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 ${
                isMuted ? 'bg-bubble-in text-danger' : 'bg-pressed text-app hover:opacity-80'
              }`}
              title={isMuted ? 'Unmute' : 'Mute'} aria-label={isMuted ? 'Unmute' : 'Mute'}
             aria-pressed={isMuted} >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {effectiveCallType === 'video' && (
              <button
                onClick={handleToggleVideo}
                className={`w-11 h-11 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 ${
                  !isVideoEnabled ? 'bg-bubble-in text-danger' : 'bg-pressed text-app hover:opacity-80'
                }`}
                title={isVideoEnabled ? 'Camera off' : 'Camera on'} aria-label={isVideoEnabled ? 'Camera off' : 'Camera on'}
               aria-pressed={isVideoEnabled} >
                {isVideoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
              </button>
            )}

            {effectiveCallType === 'video' && hasVideoTrack && (
              <button
                onClick={handleFlipCamera}
                disabled={isScreenSharing}
                className="w-11 h-11 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 bg-pressed text-app hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                title={
                  isScreenSharing
                    ? lang === 'bn'
                      ? 'স্ক্রিন শেয়ারের সময় ক্যামেরা বদলানো যাবে না'
                      : 'Camera flip is unavailable while sharing your screen'
                    : lang === 'bn'
                      ? 'ক্যামেরা বদলান'
                      : 'Flip camera'
                } aria-label={
                  isScreenSharing
                    ? lang === 'bn'
                      ? 'স্ক্রিন শেয়ারের সময় ক্যামেরা বদলানো যাবে না'
                      : 'Camera flip is unavailable while sharing your screen'
                    : lang === 'bn'
                      ? 'ক্যামেরা বদলান'
                      : 'Flip camera'
                }
              >
                <SwitchCamera className="w-5 h-5" />
              </button>
            )}

            {/* Phase 1.3 screen share — works in audio calls too (a video
                sender is added on the fly). Disabled with an explanatory
                tooltip when getDisplayMedia is unavailable or the call is
                not connected yet. */}
            <button
              onClick={() => {
                if (isScreenSharing) void stopScreenShare();
                else void startScreenShare();
              }}
              disabled={!screenShareSupported || status !== 'connected'}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                isScreenSharing ? 'bg-bubble-in text-primary' : 'bg-pressed text-app hover:opacity-80'
              }`}
              title={
                !screenShareSupported
                  ? lang === 'bn'
                    ? 'এই ব্রাউজারে স্ক্রিন শেয়ার সাপোর্ট নেই'
                    : 'Screen sharing is not supported in this browser'
                  : status !== 'connected'
                    ? lang === 'bn'
                      ? 'সংযোগ হলে স্ক্রিন শেয়ার করা যাবে'
                      : 'Screen share is available once connected'
                    : isScreenSharing
                      ? lang === 'bn'
                        ? 'শেয়ার বন্ধ করুন'
                        : 'Stop sharing'
                      : lang === 'bn'
                        ? 'স্ক্রিন শেয়ার করুন'
                        : 'Share screen'
              } aria-label={
                !screenShareSupported
                  ? lang === 'bn'
                    ? 'এই ব্রাউজারে স্ক্রিন শেয়ার সাপোর্ট নেই'
                    : 'Screen sharing is not supported in this browser'
                  : status !== 'connected'
                    ? lang === 'bn'
                      ? 'সংযোগ হলে স্ক্রিন শেয়ার করা যাবে'
                      : 'Screen share is available once connected'
                    : isScreenSharing
                      ? lang === 'bn'
                        ? 'শেয়ার বন্ধ করুন'
                        : 'Stop sharing'
                      : lang === 'bn'
                        ? 'স্ক্রিন শেয়ার করুন'
                        : 'Share screen'
              }
             aria-pressed={isScreenSharing} >
              {isScreenSharing ? <ScreenShareOff className="w-5 h-5" /> : <ScreenShare className="w-5 h-5" />}
            </button>

            <button
              onClick={handleEndCall}
              className="w-12 h-12 shrink-0 rounded-full bg-danger hover:opacity-90 text-white flex items-center justify-center shadow-soft transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95"
              title={lang === 'bn' ? 'কল শেষ করুন' : 'End call'} aria-label={lang === 'bn' ? 'কল শেষ করুন' : 'End call'}
            >
              <PhoneOff className="w-5 h-5" />
            </button>

            <button
              onClick={handleToggleSpeaker}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-transform duration-[var(--dur-press)] ease-[var(--ease-spring)] active:scale-95 ${
                isSpeakerOn ? 'bg-bubble-in text-primary' : 'bg-pressed text-app-2'
              }`}
              title={lang === 'bn' ? 'স্পিকার' : 'Speaker'} aria-label={lang === 'bn' ? 'স্পিকার' : 'Speaker'}
             aria-pressed={isSpeakerOn} >
              <Volume2 className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* PiP tile bar — only visible minimized; overlays the bottom of
            the tile. Timer + expand + end-call. Buttons stop propagation
            so they never start a drag or trigger tap-to-restore. */}
        {isMinimized && (
          <div className="absolute bottom-0 inset-x-0 z-10 flex items-center justify-between gap-2 px-2.5 py-1.5 bg-black/55 text-white">
            <span className="text-[11px] font-mono font-semibold tabular-nums">
              {status === 'connected' ? formatTimer(callDuration) : statusText}
            </span>
            <span className="flex items-center gap-1">
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMinimized(false);
                }}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 text-white"
                aria-label={lang === 'bn' ? 'বড় করুন' : 'Expand call'}
                title={lang === 'bn' ? 'বড় করুন' : 'Expand call'}
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleEndCall();
                }}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-[#E5484D] hover:opacity-90 text-white"
                aria-label={lang === 'bn' ? 'কল শেষ করুন' : 'End call'}
                title={lang === 'bn' ? 'কল শেষ করুন' : 'End call'}
              >
                <PhoneOff className="w-3.5 h-3.5" />
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
