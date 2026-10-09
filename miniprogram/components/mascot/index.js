const FRONT_IMAGE = '/assets/mascot/xiaomotuan-front.png';
const TURNED_IMAGE = '/assets/mascot/xiaomotuan-turned.png';
const FALLBACK_IMAGE = '/assets/xiaomotuan-small.png';

Component({
  properties: {
    compact: { type: Boolean, value: false },
    interactive: { type: Boolean, value: true }
  },
  data: {
    image: FRONT_IMAGE,
    fallback: false,
    turned: false
  },
  lifetimes: {
    detached() {
      if (this._turnTimer) clearTimeout(this._turnTimer);
    }
  },
  methods: {
    turn() {
      if (!this.data.interactive || this.data.fallback) return;
      if (this._turnTimer) clearTimeout(this._turnTimer);
      this.setData({ image: TURNED_IMAGE, turned: true });
      this._turnTimer = setTimeout(() => {
        this.setData({ image: FRONT_IMAGE, turned: false });
        this._turnTimer = null;
      }, 900);
    },
    onImageError() {
      if (this.data.fallback) return;
      this.setData({ image: FALLBACK_IMAGE, fallback: true, turned: false });
    }
  }
});
