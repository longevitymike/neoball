import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Ball texture configurations - 6 unique textures, 2 of each = 12 balls
// We normalize textures at load time so every ball has the same visual diameter.
const BALL_TEXTURES = [
  { path: './balls/balls1.webp' },
  { path: './balls/balls2.webp' },
  { path: './balls/balls3.webp' },
  { path: './balls/balls4.webp' },
  { path: './balls/balls5.webp' },
  { path: './balls/balls6.webp' }
];

// Number of balls per texture (2 of each = 12 total)
const BALLS_PER_TEXTURE = 2;

// Unique instance id counter (supports multiple overlays on the same page)
let OVERLAY_INSTANCE_ID = 0;

export class NeoballBallsOverlay {
  constructor(options = {}) {
    this._isMobile = this.detectMobile();

    // Calculate total balls: 6 textures × 2 each = 12
    const defaultBallCount = BALL_TEXTURES.length * BALLS_PER_TEXTURE;

    this.instanceId = ++OVERLAY_INSTANCE_ID;

    this.config = {
      // If you pass a wrapper div (#ballsBack / #ballsFront), we mount into it.
      // If you don't, we mount into body as fixed.
      container: options.container || document.body,

      // Visual layer stacking
      zIndex: options.zIndex ?? 80,

      // 3D separation between layers (back negative, front positive)
      // This is subtle but helps depth and avoids z-sorting weirdness.
      zOffset: options.zOffset ?? 0,

      // Ball settings
      ballCount: options.ballCount ?? defaultBallCount,
      ballRadius: options.ballRadius ?? 1.0,

      gravity: 0,

      restitution: options.restitution ?? 0.3,
      friction: options.friction ?? 0.5,
      linearDamping: options.linearDamping ?? 0.4,
      angularDamping: options.angularDamping ?? 0.3,
      oscGravity: options.oscGravity ?? 0.015,
      velocityFromPositionScale: options.velocityFromPositionScale ?? 0.2,

      // Optional: set a custom id/class on the created overlay element
      overlayId: options.overlayId ?? `neoball-balls-overlay-${this.instanceId}`,
      overlayClass: options.overlayClass ?? '',

      ...options
    };

    this.balls = [];
    this.textures = [];
    this.clock = new THREE.Clock();
    this._t = 0;
    this.pointer = { x: 0, y: 0 };
    this.hasPointer = false;

    this.viewport = { width: 0, height: 0, aspect: 1 };

    this.init();
  }

  detectMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || window.innerWidth < 768
      || ('ontouchstart' in window);
  }

  async init() {
    this.createContainer();
    this.createScene();
    this.setViewport();
    this.createPhysicsWorld();
    this.createBoundaries();
    this.createPointerCollider();
    await this.loadAllTextures();
    this.createBalls();
    this.bindEvents();
    this.animate();

    // Expose for debugging
    window.neoballBalls = window.neoballBalls || [];
    window.neoballBalls.push(this);
  }

  createContainer() {
    this.containerEl = document.createElement('div');
    this.containerEl.id = this.config.overlayId;
    if (this.config.overlayClass) this.containerEl.className = this.config.overlayClass;

    const isBody = (this.config.container === document.body);

    // If mounting into body → fixed full screen.
    // If mounting into a layer wrapper div → absolute fill inside
    this.containerEl.style.cssText = isBody
      ? `position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;z-index:${this.config.zIndex};pointer-events:none;overflow:hidden;`
      : `position:absolute;inset:0;width:100%;height:100%;z-index:${this.config.zIndex};pointer-events:none;overflow:hidden;`;

    // Ensure wrapper can contain absolute children
    if (!isBody) {
      const cs = window.getComputedStyle(this.config.container);
      if (cs.position === 'static') this.config.container.style.position = 'relative';
    }

    this.config.container.appendChild(this.containerEl);
  }

  createScene() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.scene = new THREE.Scene();

    // Perspective camera
    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 1000);
    this.camera.position.set(0, 0, 20);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !this._isMobile,
      powerPreference: this._isMobile ? 'low-power' : 'high-performance'
    });

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.pointerEvents = 'none';

    // Helps correct draw ordering when multiple sprites overlap
    this.renderer.sortObjects = true;

    this.containerEl.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
    keyLight.position.set(200, 200, 300);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x88ccff, 0.3);
    fillLight.position.set(-150, 50, 200);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0x00ffff, 0.15);
    rimLight.position.set(0, -100, -100);
    this.scene.add(rimLight);
  }

  setViewport() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const distance = this.camera.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 0, 0));
    const fovRad = this.camera.fov * Math.PI / 180;
    const viewHeight = 2 * Math.tan(fovRad / 2) * distance;
    const viewWidth = viewHeight * this.camera.aspect;

    this.viewport = { width: viewWidth, height: viewHeight, aspect: this.camera.aspect };
  }

  createPhysicsWorld() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, 0, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = false;
    this.world.solver.iterations = 10;
    this.world.defaultContactMaterial.contactEquationStiffness = 1e6;
    this.world.defaultContactMaterial.contactEquationRelaxation = 10;

    this.ballMaterial = new CANNON.Material('ball');
    this.wallMaterial = new CANNON.Material('wall');
    this.pointerMaterial = new CANNON.Material('pointer');

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.ballMaterial, this.ballMaterial,
      { friction: this.config.friction, restitution: this.config.restitution }
    ));
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.ballMaterial, this.wallMaterial,
      { friction: this.config.friction, restitution: this.config.restitution }
    ));
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.ballMaterial, this.pointerMaterial,
      { friction: this.config.friction, restitution: this.config.restitution }
    ));
  }

  createPointerCollider() {
    const ballDiameter = this.config.ballRadius * 2;
    const boxSize = ballDiameter * 1.5;
    const shape = new CANNON.Box(new CANNON.Vec3(boxSize / 2, boxSize / 2, ballDiameter));

    this.pointerBox = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      material: this.pointerMaterial
    });

    this.pointerBox.addShape(shape);
    this.pointerBox.position.set(99999, 99999, this.config.zOffset);
    this.world.addBody(this.pointerBox);
  }

  createBoundaries() {
    const ballDiameter = this.config.ballRadius * 2;
    const boxSize = ballDiameter * 1.5;
    const wallDepth = Math.max(boxSize, ballDiameter) * 1.1;
    const t = wallDepth;

    const w = this.viewport.width;
    const h = this.viewport.height;

    const z = this.config.zOffset;

    const configs = [
      { pos: [0, -h / 2 - t / 2, z], size: [w * 2, t, t] },
      { pos: [0,  h / 2 + t / 2, z], size: [w * 2, t, t] },
      { pos: [-w / 2 - t / 2, 0, z], size: [t, h * 2, t] },
      { pos: [ w / 2 + t / 2, 0, z], size: [t, h * 2, t] },
      { pos: [0, 0, z - t], size: [w * 2, h * 2, t] },
      { pos: [0, 0, z + t], size: [w * 2, h * 2, t] }
    ];

    this.walls = configs.map((c) => {
      const body = new CANNON.Body({ mass: 0, material: this.wallMaterial, position: new CANNON.Vec3(...c.pos) });
      body.addShape(new CANNON.Box(new CANNON.Vec3(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2)));
      this.world.addBody(body);
      return body;
    });
  }

  normalizeBallTexture(texture) {
    const img = texture.image;
    if (!img) return texture;

    const OUT = 512;
    const TARGET_DIAMETER = Math.round(OUT * 0.86);
    const THRESH = 8;

    const srcCanvas = document.createElement('canvas');
    const sw = img.width || img.naturalWidth || 0;
    const sh = img.height || img.naturalHeight || 0;
    if (!sw || !sh) return texture;

    srcCanvas.width = sw;
    srcCanvas.height = sh;
    const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    if (!sctx) return texture;

    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(img, 0, 0);

    let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
    try {
      const data = sctx.getImageData(0, 0, sw, sh).data;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const a = data[(y * sw + x) * 4 + 3];
          if (a > THRESH) {
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
        }
      }
    } catch {
      return texture;
    }

    if (x1 < x0 || y1 < y0) return texture;

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const b = Math.max(bw, bh);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const cropX = Math.max(0, Math.floor(cx - b / 2));
    const cropY = Math.max(0, Math.floor(cy - b / 2));
    const cropW = Math.min(sw - cropX, b);
    const cropH = Math.min(sh - cropY, b);

    const out = document.createElement('canvas');
    out.width = OUT;
    out.height = OUT;
    const octx = out.getContext('2d');
    if (!octx) return texture;

    octx.clearRect(0, 0, OUT, OUT);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';

    const scale = TARGET_DIAMETER / Math.max(cropW, cropH);
    const dw = cropW * scale;
    const dh = cropH * scale;
    const dx = (OUT - dw) / 2;
    const dy = (OUT - dh) / 2;

    octx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, dx, dy, dw, dh);

    octx.globalCompositeOperation = 'destination-in';
    octx.beginPath();
    octx.arc(OUT / 2, OUT / 2, TARGET_DIAMETER / 2, 0, Math.PI * 2);
    octx.closePath();
    octx.fill();
    octx.globalCompositeOperation = 'source-over';

    const canvasTex = new THREE.CanvasTexture(out);
    canvasTex.needsUpdate = true;
    canvasTex.colorSpace = THREE.SRGBColorSpace;
    canvasTex.minFilter = THREE.LinearFilter;
    canvasTex.magFilter = THREE.LinearFilter;
    return canvasTex;
  }

  async loadAllTextures() {
    const loader = new THREE.TextureLoader();
    const loadPromises = BALL_TEXTURES.map((tex) => {
      return new Promise((resolve) => {
        loader.load(tex.path, (texture) => {
          const normalized = this.normalizeBallTexture(texture);
          resolve(normalized);
        }, undefined, () => resolve(null));
      });
    });

    this.textures = (await Promise.all(loadPromises)).filter(Boolean);
  }

  buildTextureSequence() {
    const sequence = [];
    for (let texIdx = 0; texIdx < this.textures.length; texIdx++) {
      for (let i = 0; i < BALLS_PER_TEXTURE; i++) sequence.push(texIdx);
    }
    for (let i = sequence.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
    }
    return sequence;
  }

  getRandomPositionForBody(existing, safeDistance) {
    const w = this.viewport.width;
    const h = this.viewport.height;

    const padX = Math.max(this.config.ballRadius * 2, w * 0.2);
    const padY = Math.max(this.config.ballRadius * 2, h * 0.2);

    for (;;) {
      const x = (Math.random() * (w - padX * 2) + padX) - w / 2;
      const y = (Math.random() * (h - padY * 2) + padY) - h / 2;

      let ok = true;
      for (const p of existing) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < safeDistance * safeDistance) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
  }

  createBalls() {
    const r = this.config.ballRadius;
    const ballDiameter = r * 2;
    const boxSize = ballDiameter * 1.5;
    const safeDistance = Math.max(boxSize, ballDiameter) * 1.25;

    const positions = [];
    const textureSequence = this.buildTextureSequence();
    const ballCount = Math.min(this.config.ballCount, textureSequence.length);

    const z = this.config.zOffset;

    for (let i = 0; i < ballCount; i++) {
      const { x, y } = this.getRandomPositionForBody(positions, safeDistance);
      positions.push({ x, y });

      const textureIndex = textureSequence[i];
      const texture = this.textures[textureIndex] || this.textures[0];

      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.1,
        depthTest: true,
        depthWrite: false
      });

      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.scale.set(r * 2, r * 2, 1);
      sprite.position.set(x, y, z);

      // Helps draw order if sprites overlap (especially between back/front layers)
      sprite.renderOrder = this.config.zOffset >= 0 ? 2 : 1;

      this.scene.add(sprite);

      const body = new CANNON.Body({
        mass: 50,
        material: this.ballMaterial,
        linearDamping: this.config.linearDamping,
        angularDamping: this.config.angularDamping
      });

      body.addShape(new CANNON.Sphere(r));
      body.position.set(x, y, z);

      const vx = (-0.5 + Math.random()) * x * 2 * this.config.velocityFromPositionScale;
      const vy = (-0.5 + Math.random()) * y * 2 * this.config.velocityFromPositionScale;
      body.velocity.set(vx, vy, 0);

      this.world.addBody(body);
      this.balls.push({ sprite, body, index: i, textureIndex });
    }
  }

  getPointerWorld(clientX, clientY) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const n = w / this.viewport.width;
    const mx = clientX - w / 2;
    const my = clientY - h / 2;
    return { x: mx / n, y: -my / n };
  }

  bindEvents() {
    this._onMove = (e) => {
      const p = this.getPointerWorld(e.clientX, e.clientY);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.hasPointer = true;
    };

    this._onTouchMove = (e) => {
      if (e.touches && e.touches[0]) {
        const t = e.touches[0];
        const p = this.getPointerWorld(t.clientX, t.clientY);
        this.pointer.x = p.x;
        this.pointer.y = p.y;
        this.hasPointer = true;
      }
    };

    this._onResize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.setViewport();
      this.updateBoundaries();
    };

    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mousedown', this._onMove);
    window.addEventListener('touchmove', this._onTouchMove, { passive: true });
    window.addEventListener('resize', this._onResize);
  }

  updateBoundaries() {
    const ballDiameter = this.config.ballRadius * 2;
    const boxSize = ballDiameter * 1.5;
    const t = Math.max(boxSize, ballDiameter) * 1.1;
    const w = this.viewport.width;
    const h = this.viewport.height;
    const z = this.config.zOffset;

    const positions = [
      [0, -h / 2 - t / 2, z],
      [0,  h / 2 + t / 2, z],
      [-w / 2 - t / 2, 0, z],
      [ w / 2 + t / 2, 0, z],
      [0, 0, z - t],
      [0, 0, z + t]
    ];

    this.walls.forEach((wall, i) => wall.position.set(...positions[i]));
  }

  animate() {
    requestAnimationFrame(this.animate.bind(this));

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.world.step(1 / 60, dt, 3);

    this._t += dt;
    this.world.gravity.set(
      Math.sin(0.5 * this._t) * this.config.oscGravity,
      Math.cos(0.4 * this._t) * this.config.oscGravity,
      0
    );

    if (this.pointerBox) {
      if (!this.hasPointer) {
        this.pointerBox.position.set(99999, 99999, this.config.zOffset);
      } else {
        this.pointerBox.position.set(this.pointer.x, this.pointer.y, this.config.zOffset);
        this.pointerBox.quaternion.set(Math.sin(this._t), Math.cos(this._t), 0, 0);
      }
    }

    for (const b of this.balls) {
      b.sprite.position.x = b.body.position.x;
      b.sprite.position.y = b.body.position.y;
      b.sprite.position.z = this.config.zOffset; // keep layer separation consistent

      b.sprite.material.rotation += (b.body.velocity.x + b.body.velocity.y) * 0.0005;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

export function initBallsOnPage(options = {}) {
  return new NeoballBallsOverlay(options);
}
