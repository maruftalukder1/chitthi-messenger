// WebAudio ringtone — no audio assets needed.
// Classic dual-tone (440 + 480 Hz) ring: 2s on, 4s off, low volume.
// All wrapped in try/catch because autoplay policies can block AudioContext
// creation/resume before a user gesture.

let ctx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let oscillators: OscillatorNode[] = [];
let timerId: ReturnType<typeof setTimeout> | null = null;
let isPlaying = false;

export function isRingtoneEnabled(): boolean {
  try {
    return localStorage.getItem('chitthi_ringtone') !== '0';
  } catch {
    return true;
  }
}

function ensureContext(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      gainNode.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  } catch {
    return null;
  }
}

function startTones() {
  try {
    const audioCtx = ensureContext();
    if (!audioCtx || !gainNode) return;
    stopTones();
    for (const freq of [440, 480]) {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gainNode);
      osc.start();
      oscillators.push(osc);
    }
    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
  } catch {
    // best-effort only
  }
}

function stopTones() {
  try {
    if (gainNode && ctx) {
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
    }
    for (const osc of oscillators) {
      try { osc.stop(); } catch { /* already stopped */ }
      try { osc.disconnect(); } catch { /* ignore */ }
    }
    oscillators = [];
  } catch {
    // ignore
  }
}

// Chain timeouts for the 2s-on / 4s-off cadence.
function scheduleOff() {
  timerId = setTimeout(() => {
    if (!isPlaying) return;
    stopTones();
    timerId = setTimeout(() => {
      if (!isPlaying) return;
      startTones();
      scheduleOff();
    }, 4000);
  }, 2000);
}

export function startRingtone(): void {
  try {
    if (isPlaying) return; // idempotent — no double contexts/timers
    isPlaying = true;
    startTones();
    scheduleOff();
  } catch {
    isPlaying = false;
  }
}

export function stopRingtone(): void {
  try {
    isPlaying = false;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    stopTones();
    if (ctx) {
      ctx.suspend().catch(() => {});
    }
  } catch {
    // ignore
  }
}
