/**
 * Neoball Physics System
 * Three.js + Cannon-es for realistic ball physics
 * Inspired by newyorksunshine.com tennis ball effect
 */

// Use global THREE and CANNON (set by importmap in HTML)
const THREE = window.THREE;
const CANNON = window.CANNON;

class NeoballPhysics {
  constructor(options = {}) {
    // Detect mobile
    this._isMobile = this.detectMobile();

    // Configuration
    this.config = {
      container: options.container || document.body,
      ballTexture: options.ballTexture || './images/ball-front.png',
      ballCount: options.ballCount || (this._isMobile ? 8 : 12),
      ballRadius: options.ballRadius || (this._isMobile ? 35 : 45),
      gravity: options.gravity || -15,
      restitution: options.restitution || 0.7,
      friction: options.friction || 0.3,
      linearDamping: options.linearDamping || 0.1,
      angularDamping: options.angularDamping || 0.3,
      throwForce: options.throwForce || 30,
      ...options
    };

    // State
    this.balls = [];
    this.selectedBall = null;
    this.isDragging = false;
    this.mouse = new THREE.Vector2();
    this.lastMouse = new THREE.Vector2();
    this.lastMouseTime = 0;
    this.dragVelocity = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();

    // Performance monitoring
    this.frameCount = 0;
    this.lastFpsUpdate = 0;
    this.fps = 60;

    // Initialize
    this.init();
  }

  detectMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || window.innerWidth < 768
      || ('ontouchstart' in window);
  }

  isMobile() {
    return this._isMobile;
  }

  init() {
    this.createContainer();
    this.createScene();
    this.createPhysicsWorld();
    this.createBoundaries();
    this.loadTexture().then(() => {
      this.createBalls();
      this.bindEvents();
      this.animate();
      console.log('Neoball Physics initialized', {
        mobile: this._isMobile,
        balls: this.config.ballCount
      });
    });
  }

  createContainer() {
    // Create overlay container
    this.containerEl = document.createElement('div');
    this.containerEl.id = 'neoball-physics-container';
    this.containerEl.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh;
      z-index: 1000;
      pointer-events: none;
      overflow: hidden;
    `;
    this.config.container.appendChild(this.containerEl);
  }

  createScene() {
    // Three.js setup
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Scene
    this.scene = new THREE.Scene();

    // Orthographic camera for 2D-like rendering
    const aspect = width / height;
    const frustumSize = height;
    this.camera = new THREE.OrthographicCamera(
      -frustumSize * aspect / 2,
      frustumSize * aspect / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      1000
    );
    this.camera.position.z = 500;

    // Renderer with mobile optimizations
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !this._isMobile,
      powerPreference: this._isMobile ? 'low-power' : 'high-performance',
      stencil: false,
      depth: true
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this._isMobile ? 2 : 2.5));
    this.renderer.setClearColor(0x000000, 0);

    // Enable pointer events on canvas for raycasting
    this.renderer.domElement.style.pointerEvents = 'auto';
    this.renderer.domElement.style.touchAction = 'none'; // Prevent default touch behaviors
    this.containerEl.appendChild(this.renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(100, 100, 100);
    this.scene.add(directionalLight);

    // Add subtle rim light for 3D effect
    const rimLight = new THREE.DirectionalLight(0x00FFFF, 0.2);
    rimLight.position.set(-100, -50, 50);
    this.scene.add(rimLight);
  }

  createPhysicsWorld() {
    // Cannon.js physics world
    this.world = new CANNON.World();
    this.world.gravity.set(0, this.config.gravity, 0);

    // Use SAPBroadphase for better performance with many objects
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true; // Allow bodies to sleep for performance
    this.world.solver.iterations = this._isMobile ? 5 : 10;

    // Default materials
    this.ballMaterial = new CANNON.Material('ball');
    this.wallMaterial = new CANNON.Material('wall');

    // Contact material for ball-ball collisions
    const ballBallContact = new CANNON.ContactMaterial(this.ballMaterial, this.ballMaterial, {
      friction: this.config.friction,
      restitution: this.config.restitution
    });

    // Contact material for ball-wall collisions
    const ballWallContact = new CANNON.ContactMaterial(this.ballMaterial, this.wallMaterial, {
      friction: 0.1,
      restitution: this.config.restitution * 0.8
    });

    this.world.addContactMaterial(ballBallContact);
    this.world.addContactMaterial(ballWallContact);
  }

  createBoundaries() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const wallThickness = 100;

    // Create invisible walls (floor, ceiling, left, right)
    const wallConfigs = [
      { pos: [0, -height/2 - wallThickness/2, 0], size: [width * 2, wallThickness, 200] }, // Floor
      { pos: [0, height/2 + wallThickness/2, 0], size: [width * 2, wallThickness, 200] },  // Ceiling
      { pos: [-width/2 - wallThickness/2, 0, 0], size: [wallThickness, height * 2, 200] }, // Left
      { pos: [width/2 + wallThickness/2, 0, 0], size: [wallThickness, height * 2, 200] }   // Right
    ];

    this.walls = [];
    wallConfigs.forEach(config => {
      const shape = new CANNON.Box(new CANNON.Vec3(config.size[0]/2, config.size[1]/2, config.size[2]/2));
      const body = new CANNON.Body({
        mass: 0, // Static
        material: this.wallMaterial,
        position: new CANNON.Vec3(...config.pos),
        collisionFilterGroup: 2,
        collisionFilterMask: 1
      });
      body.addShape(shape);
      this.world.addBody(body);
      this.walls.push(body);
    });
  }

  async loadTexture() {
    return new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        this.config.ballTexture,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          this.ballTextureMap = texture;
          resolve();
        },
        undefined,
        (error) => {
          console.warn('Failed to load ball texture, using fallback color:', error);
          this.ballTextureMap = null;
          resolve();
        }
      );
    });
  }

  createBalls() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Sphere geometry (reused for all balls)
    const geometry = new THREE.SphereGeometry(
      this.config.ballRadius,
      this._isMobile ? 24 : 32,
      this._isMobile ? 24 : 32
    );

    for (let i = 0; i < this.config.ballCount; i++) {
      // Random starting position (spread across screen, biased toward top)
      const x = (Math.random() - 0.5) * width * 0.7;
      const y = Math.random() * height * 0.4 + height * 0.1 - height/2 + height/2;
      const z = 0;

      // Create material (clone texture for independent rotation)
      let material;
      if (this.ballTextureMap) {
        material = new THREE.MeshStandardMaterial({
          map: this.ballTextureMap,
          roughness: 0.5,
          metalness: 0.05,
          envMapIntensity: 0.5
        });
      } else {
        material = new THREE.MeshStandardMaterial({
          color: 0x00FFFF,
          roughness: 0.5,
          metalness: 0.05
        });
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);

      // Random initial rotation
      mesh.rotation.set(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2
      );

      this.scene.add(mesh);

      // Create physics body
      const shape = new CANNON.Sphere(this.config.ballRadius);
      const body = new CANNON.Body({
        mass: 1,
        material: this.ballMaterial,
        linearDamping: this.config.linearDamping,
        angularDamping: this.config.angularDamping,
        collisionFilterGroup: 1,
        collisionFilterMask: 1 | 2,
        sleepSpeedLimit: 0.5,
        sleepTimeLimit: 1
      });
      body.addShape(shape);
      body.position.set(x, y, z);

      // Random initial velocity
      body.velocity.set(
        (Math.random() - 0.5) * 80,
        (Math.random() - 0.5) * 40,
        0
      );

      // Random initial spin
      body.angularVelocity.set(
        (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 3
      );

      this.world.addBody(body);

      // Store ball reference
      this.balls.push({
        mesh,
        body,
        index: i
      });
    }
  }

  bindEvents() {
    // Mouse events
    this.renderer.domElement.addEventListener('mousedown', this.onPointerDown.bind(this));
    window.addEventListener('mousemove', this.onPointerMove.bind(this));
    window.addEventListener('mouseup', this.onPointerUp.bind(this));

    // Touch events
    this.renderer.domElement.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
    window.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
    window.addEventListener('touchend', this.onTouchEnd.bind(this));
    window.addEventListener('touchcancel', this.onTouchEnd.bind(this));

    // Resize
    window.addEventListener('resize', this.onResize.bind(this));

    // Visibility change (pause when tab hidden)
    document.addEventListener('visibilitychange', this.onVisibilityChange.bind(this));

    // Device orientation for gravity (mobile)
    if (this._isMobile && window.DeviceOrientationEvent) {
      // Request permission on iOS 13+
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // Need user gesture to request
        const requestPermission = () => {
          DeviceOrientationEvent.requestPermission()
            .then(response => {
              if (response === 'granted') {
                window.addEventListener('deviceorientation', this.onDeviceOrientation.bind(this));
              }
            })
            .catch(console.error);
          document.removeEventListener('touchstart', requestPermission);
        };
        document.addEventListener('touchstart', requestPermission, { once: true });
      } else {
        window.addEventListener('deviceorientation', this.onDeviceOrientation.bind(this));
      }
    }
  }

  getPointerPosition(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
      screenX: clientX - window.innerWidth / 2,
      screenY: -(clientY - window.innerHeight / 2)
    };
  }

  onPointerDown(event) {
    const pos = this.getPointerPosition(event.clientX, event.clientY);
    this.mouse.set(pos.x, pos.y);
    this.lastMouse.set(pos.screenX, pos.screenY);
    this.lastMouseTime = performance.now();

    // Raycast to find clicked ball
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.balls.map(b => b.mesh));

    if (intersects.length > 0) {
      const clickedMesh = intersects[0].object;
      this.selectedBall = this.balls.find(b => b.mesh === clickedMesh);
      this.isDragging = true;

      if (this.selectedBall) {
        // Wake up the body and stop its motion
        this.selectedBall.body.wakeUp();
        this.selectedBall.body.velocity.setZero();
        this.selectedBall.body.angularVelocity.setZero();

        // Haptic feedback
        this.vibrate(10);
      }
    }
  }

  onPointerMove(event) {
    if (!this.isDragging || !this.selectedBall) return;

    const now = performance.now();
    const dt = Math.max(now - this.lastMouseTime, 1);
    const pos = this.getPointerPosition(event.clientX, event.clientY);

    // Calculate velocity based on movement
    this.dragVelocity.set(
      (pos.screenX - this.lastMouse.x) / dt * 16, // Normalize to ~60fps
      (pos.screenY - this.lastMouse.y) / dt * 16
    );

    // Move ball towards cursor with spring-like following
    const body = this.selectedBall.body;
    const dx = pos.screenX - body.position.x;
    const dy = pos.screenY - body.position.y;

    // Apply velocity towards cursor (creates smooth following)
    body.velocity.x = dx * 0.25;
    body.velocity.y = dy * 0.25;

    this.lastMouse.set(pos.screenX, pos.screenY);
    this.lastMouseTime = now;
  }

  onPointerUp() {
    if (this.selectedBall && this.isDragging) {
      // Apply throw velocity
      const throwMultiplier = this.config.throwForce;

      // Clamp velocity to prevent crazy throws
      const maxVel = 50;
      const vx = Math.max(-maxVel, Math.min(maxVel, this.dragVelocity.x));
      const vy = Math.max(-maxVel, Math.min(maxVel, this.dragVelocity.y));

      this.selectedBall.body.velocity.x = vx * throwMultiplier;
      this.selectedBall.body.velocity.y = vy * throwMultiplier;

      // Add spin based on throw direction
      this.selectedBall.body.angularVelocity.set(
        vy * 0.15,
        -vx * 0.15,
        (Math.random() - 0.5) * 2
      );

      // Haptic feedback
      this.vibrate(5);
    }

    this.selectedBall = null;
    this.isDragging = false;
    this.dragVelocity.set(0, 0);
  }

  onTouchStart(event) {
    event.preventDefault();
    if (event.touches.length > 0) {
      const touch = event.touches[0];
      this.onPointerDown({
        clientX: touch.clientX,
        clientY: touch.clientY
      });
    }
  }

  onTouchMove(event) {
    if (this.isDragging) {
      event.preventDefault();
    }
    if (event.touches.length > 0) {
      const touch = event.touches[0];
      this.onPointerMove({
        clientX: touch.clientX,
        clientY: touch.clientY
      });
    }
  }

  onTouchEnd() {
    this.onPointerUp();
  }

  onDeviceOrientation(event) {
    if (event.gamma === null || event.beta === null) return;

    // gamma: left/right tilt (-90 to 90)
    // beta: front/back tilt (-180 to 180)
    const gamma = Math.max(-45, Math.min(45, event.gamma));
    const beta = Math.max(-45, Math.min(45, event.beta - 45)); // Offset for natural phone holding

    // Map tilt to gravity
    const gravityX = gamma * 0.4;
    const gravityY = this.config.gravity + beta * 0.3;

    this.world.gravity.set(gravityX, Math.min(gravityY, -3), 0);
  }

  onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Update camera
    const aspect = width / height;
    const frustumSize = height;
    this.camera.left = -frustumSize * aspect / 2;
    this.camera.right = frustumSize * aspect / 2;
    this.camera.top = frustumSize / 2;
    this.camera.bottom = -frustumSize / 2;
    this.camera.updateProjectionMatrix();

    // Update renderer
    this.renderer.setSize(width, height);

    // Update container height for mobile browsers
    this.containerEl.style.height = `${height}px`;

    // Update wall positions
    this.updateBoundaries();
  }

  onVisibilityChange() {
    if (document.hidden) {
      this.clock.stop();
    } else {
      this.clock.start();
    }
  }

  updateBoundaries() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const wallThickness = 100;

    const positions = [
      [0, -height/2 - wallThickness/2, 0],
      [0, height/2 + wallThickness/2, 0],
      [-width/2 - wallThickness/2, 0, 0],
      [width/2 + wallThickness/2, 0, 0]
    ];

    this.walls.forEach((wall, i) => {
      wall.position.set(...positions[i]);
    });
  }

  vibrate(duration = 10) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(duration);
      } catch (e) {
        // Ignore vibration errors
      }
    }
  }

  animate() {
    if (document.hidden) {
      requestAnimationFrame(this.animate.bind(this));
      return;
    }

    requestAnimationFrame(this.animate.bind(this));

    // Fixed timestep physics
    const delta = this.clock.getDelta();
    const timeStep = 1 / 60;
    const maxSubSteps = this._isMobile ? 2 : 3;

    this.world.step(timeStep, delta, maxSubSteps);

    // Sync meshes with physics bodies
    for (let i = 0; i < this.balls.length; i++) {
      const ball = this.balls[i];
      ball.mesh.position.copy(ball.body.position);
      ball.mesh.quaternion.copy(ball.body.quaternion);
    }

    // Render
    this.renderer.render(this.scene, this.camera);

    // FPS monitoring (debug)
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate > 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }

  // Public API

  addBall() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = (Math.random() - 0.5) * width * 0.5;
    const y = height / 3;

    const geometry = new THREE.SphereGeometry(
      this.config.ballRadius,
      this._isMobile ? 24 : 32,
      this._isMobile ? 24 : 32
    );

    const material = this.ballTextureMap
      ? new THREE.MeshStandardMaterial({ map: this.ballTextureMap, roughness: 0.5, metalness: 0.05 })
      : new THREE.MeshStandardMaterial({ color: 0x00FFFF, roughness: 0.5, metalness: 0.05 });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, 0);
    mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, 0);
    this.scene.add(mesh);

    const shape = new CANNON.Sphere(this.config.ballRadius);
    const body = new CANNON.Body({
      mass: 1,
      material: this.ballMaterial,
      linearDamping: this.config.linearDamping,
      angularDamping: this.config.angularDamping,
      collisionFilterGroup: 1,
      collisionFilterMask: 1 | 2
    });
    body.addShape(shape);
    body.position.set(x, y, 0);
    this.world.addBody(body);

    this.balls.push({ mesh, body, index: this.balls.length });
    return this.balls.length;
  }

  removeBall() {
    if (this.balls.length > 0) {
      const ball = this.balls.pop();
      this.scene.remove(ball.mesh);
      this.world.removeBody(ball.body);
      ball.mesh.geometry.dispose();
      if (ball.mesh.material.map) {
        // Don't dispose shared texture
      }
      ball.mesh.material.dispose();
    }
    return this.balls.length;
  }

  applyImpulseToAll(force = { x: 0, y: 500, z: 0 }) {
    const impulse = new CANNON.Vec3(force.x, force.y, force.z);
    this.balls.forEach(ball => {
      ball.body.wakeUp();
      ball.body.applyImpulse(impulse, ball.body.position);
      // Add random spin
      ball.body.angularVelocity.set(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      );
    });
    this.vibrate(20);
  }

  setGravity(x, y) {
    this.world.gravity.set(x, y, 0);
    // Wake all balls
    this.balls.forEach(ball => ball.body.wakeUp());
  }

  getBallCount() {
    return this.balls.length;
  }

  getFPS() {
    return this.fps;
  }

  destroy() {
    // Remove event listeners
    window.removeEventListener('resize', this.onResize.bind(this));
    window.removeEventListener('mousemove', this.onPointerMove.bind(this));
    window.removeEventListener('mouseup', this.onPointerUp.bind(this));
    window.removeEventListener('touchmove', this.onTouchMove.bind(this));
    window.removeEventListener('touchend', this.onTouchEnd.bind(this));
    document.removeEventListener('visibilitychange', this.onVisibilityChange.bind(this));

    // Cleanup balls
    this.balls.forEach(ball => {
      this.scene.remove(ball.mesh);
      this.world.removeBody(ball.body);
      ball.mesh.geometry.dispose();
      ball.mesh.material.dispose();
    });

    // Cleanup renderer
    this.renderer.dispose();
    this.containerEl.remove();

    console.log('Neoball Physics destroyed');
  }
}

// Export for ES modules
export { NeoballPhysics };

// Expose globally for script tag usage
if (typeof window !== 'undefined') {
  window.NeoballPhysics = NeoballPhysics;
}
