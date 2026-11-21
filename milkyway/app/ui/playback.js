// Playback manager — IntersectionObserver-driven autoplay.
//  - A video plays when ≥ 60 % of it is on screen, and pauses the instant it drops below (no scroll listeners).
//  - Leaving the screen rewinds it, so coming back starts from the top like TikTok.
//  - Bandwidth: sources are attached only near the viewport (see `source()`); far videos have no src at all.
//  - The tab going to the background pauses everything; coming back resumes the visible one.
//  - Sound: autoplay starts muted (browser policy); one tap anywhere unmutes for the whole session.
//  - Autoplay: a per-account device preference; videos can still be started by tapping when disabled.
import { store } from '../core/store.js';
import { auth } from '../core/net.js';
import { bus } from '../core/events.js';

const THRESHOLD = 0.6;

class Playback {
  constructor() {
    this.muted = true;
    this.autoplay = true;
    this.autoplayReady = false;
    this.autoplayGeneration = 0;
    this.userPaused = new WeakSet();
    this.userStarted = new WeakSet();
    this.visible = new Set();
    this.suspended = false;
    this.listeners = new Set();
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const video = entry.target;
        if (entry.intersectionRatio >= THRESHOLD) { this.visible.add(video); this.#play(video); }
        else {
          this.visible.delete(video);
          if (!video.paused) video.pause();
          if (!entry.isIntersecting || entry.intersectionRatio === 0) {
            this.userPaused.delete(video);
            this.userStarted.delete(video);
            if (video.readyState > 0 && video.currentTime > 0) try { video.currentTime = 0; } catch {}
          }
        }
      }
    }, { threshold: [0, THRESHOLD] });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.visible.forEach(video => video.pause());
      else this.visible.forEach(video => this.#play(video));
    });

    bus.on('auth', () => { void this.loadAutoplay(); });
    void this.loadAutoplay();
  }

  async loadAutoplay() {
    const generation = ++this.autoplayGeneration;
    this.autoplayReady = false;
    const key = `${auth.userId || 'guest'}:feed:autoplay`;
    const saved = await store.get(key);
    if (generation !== this.autoplayGeneration) return this.autoplay;
    this.autoplay = saved !== false;
    this.autoplayReady = true;
    if (this.autoplay) this.visible.forEach(video => this.#play(video));
    return this.autoplay;
  }

  setAutoplay(enabled) {
    this.autoplay = Boolean(enabled);
    this.autoplayReady = true;
    this.autoplayGeneration++;
    store.set(`${auth.userId || 'guest'}:feed:autoplay`, this.autoplay);
    if (this.autoplay) this.visible.forEach(video => this.#play(video));
    else this.visible.forEach(video => { if (!this.userStarted.has(video)) video.pause(); });
  }

  observe(video) { this.observer.observe(video); }
  unobserve(video) { this.observer.unobserve(video); this.visible.delete(video); this.userStarted.delete(video); video.pause(); }

  /** Attaches or detaches a source by distance from the active slide (0 = active, ±1 = neighbours). */
  source(video, url, distance, { saveData = false } = {}) {
    const near = Math.abs(distance) <= 1;
    if (!url || !near) {
      if (video.getAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
      return;
    }
    // Active: full buffering. Next: warm up (metadata only on Data Saver). Previous: metadata.
    video.preload = distance === 0 ? 'auto' : distance === 1 && !saveData ? 'auto' : 'metadata';
    if (video.getAttribute('src') !== url) { video.src = url; }
    if (this.visible.has(video) && video.paused) this.#play(video);
  }

  /** Pauses everything (e.g. a full-screen Live is on top of the feed). */
  suspend(on) {
    this.suspended = on;
    this.visible.forEach(video => (on ? video.pause() : this.#play(video)));
  }

  toggle(video) {
    if (video.paused) { this.userPaused.delete(video); this.userStarted.add(video); this.#play(video, true); return true; }
    this.userPaused.add(video); video.pause(); return false;
  }

  setMuted(muted) {
    this.muted = muted;
    this.visible.forEach(video => { video.muted = muted; });
    this.listeners.forEach(fn => fn(muted));
  }
  onMute(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #play(video, userInitiated = false) {
    if (this.suspended || document.visibilityState === 'hidden' || this.userPaused.has(video) || !video.getAttribute('src')) return;
    if (!userInitiated && (!this.autoplayReady || (!this.autoplay && !this.userStarted.has(video)))) return;
    video.muted = this.muted;
    const attempt = video.play();
    attempt?.catch?.(error => {
      // Sound was blocked: fall back to muted autoplay and show the "tap for sound" hint.
      if (error?.name === 'NotAllowedError' && !video.muted) { this.setMuted(true); video.play().catch(() => {}); }
    });
  }
}

export const playback = new Playback();
