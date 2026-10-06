/**
 * Web implementation of the Semantic Playback player protocol on an HTMLVideoElement.
 * Mirrors the Fire OS Media3 implementation (apps/fire-tv/android): load, seek, play, pause,
 * set_rate, play_segment, loop, clear_loop. Every command resolves with the resulting PlayerState.
 */
export class WebPlayer {
  constructor(video, deviceId) {
    this.v = video;
    this.deviceId = deviceId;
    this.contentId = null;
    this.loop = null; // { startMs, endMs, remaining }
    this.segment = null; // { startMs, endMs }
    this.onChange = () => {};
    const tick = () => {
      this.enforce();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (const ev of ["play", "pause", "ratechange", "seeked", "loadedmetadata"]) video.addEventListener(ev, () => this.onChange(this.state()));
  }

  state() {
    const v = this.v;
    return {
      deviceId: this.deviceId,
      deviceKind: "web",
      contentId: this.contentId,
      positionMs: Math.round(v.currentTime * 1000),
      durationMs: Math.round((v.duration || 0) * 1000),
      paused: v.paused,
      rate: v.playbackRate,
      loop: this.loop ? { ...this.loop } : null,
      segment: this.segment ? { ...this.segment } : null,
      updatedAt: Date.now(),
    };
  }

  enforce() {
    const ms = this.v.currentTime * 1000;
    if (this.loop && ms >= this.loop.endMs) {
      this.loop.remaining -= 1;
      if (this.loop.remaining > 0) this.v.currentTime = this.loop.startMs / 1000;
      else this.loop = null;
      this.onChange(this.state());
    } else if (this.segment && ms >= this.segment.endMs) {
      this.segment = null;
      this.v.pause();
    }
  }

  seekTo(ms) {
    return new Promise((resolve) => {
      const done = () => {
        this.v.removeEventListener("seeked", done);
        resolve();
      };
      this.v.addEventListener("seeked", done);
      this.v.currentTime = Math.max(0, ms / 1000);
      setTimeout(done, 1500);
    });
  }

  async exec(c) {
    switch (c.cmd) {
      case "load":
        if (this.contentId !== c.contentId) {
          this.contentId = c.contentId;
          this.v.src = c.url;
          await new Promise((r) => this.v.addEventListener("loadedmetadata", r, { once: true }));
        }
        if (c.positionMs != null) await this.seekTo(c.positionMs);
        break;
      case "seek":
        this.loop = null;
        this.segment = null;
        await this.seekTo(c.positionMs);
        break;
      case "play":
        await this.v.play().catch(() => {});
        break;
      case "pause":
        this.v.pause();
        break;
      case "set_rate":
        this.v.playbackRate = c.rate;
        break;
      case "play_segment":
        this.loop = null;
        this.segment = { startMs: c.startMs, endMs: c.endMs };
        await this.seekTo(c.startMs);
        await this.v.play().catch(() => {});
        break;
      case "loop":
        this.segment = null;
        this.loop = { startMs: c.startMs, endMs: c.endMs, remaining: c.count };
        await this.seekTo(c.startMs);
        await this.v.play().catch(() => {});
        break;
      case "clear_loop":
        this.loop = null;
        this.segment = null;
        break;
      case "overlay":
        break; // the web TV renders cards from the turn stream
      default:
        throw new Error(`unknown command ${c.cmd}`);
    }
    return this.state();
  }
}
