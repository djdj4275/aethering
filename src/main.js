// Aethering — 3D 오픈월드 프로토타입 (Three.js)
// 3인칭 캐릭터로 프로시저럴 지형 위를 걷고/달리고/점프하고/공격한다.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createWorld } from "./entities.js";
import { createDungeon } from "./dungeon.js";
import { UI } from "./ui.js";

// ---------- 렌더러 / 씬 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 자연스러운 명암(밋밋함 완화)
renderer.toneMappingExposure = 0.85;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe0ee, 120, 290);          // 옅은 안개(원경 부드럽게)

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);

// ---------- 후처리: 블룸(발광) ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.5, 0.8);  // strength, radius, threshold(높임=진짜 밝은 것만)
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------- 하늘 (물리 기반 Sky 셰이더) + 태양 방향 ----------
const sky = new Sky();
sky.scale.setScalar(10000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 6;
skyU.rayleigh.value = 1.4;
skyU.mieCoefficient.value = 0.005;
skyU.mieDirectionalG.value = 0.8;
const sunPos = new THREE.Vector3();
{
  const elev = 55, azim = 135;                          // 태양 고도/방위(도) — 한낮
  const phi = THREE.MathUtils.degToRad(90 - elev);
  const theta = THREE.MathUtils.degToRad(azim);
  sunPos.setFromSphericalCoords(1, phi, theta);
  skyU.sunPosition.value.copy(sunPos);
}

// ---------- 조명 ----------
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x6b7a4a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
sun.position.copy(sunPos).multiplyScalar(150);          // 하늘의 태양과 같은 방향
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 250;
const sc = 90; sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
sun.shadow.bias = -0.0004;
scene.add(sun);
const ambient = new THREE.AmbientLight(0xffffff, 0);   // 폐쇄형(동굴/용암) 기본 밝기 보강용
scene.add(ambient);

// ── 투사체 조명 풀(고정 개수) ─────────────────────────────────────────────
// 투사체마다 PointLight를 씬에 add/remove 하면 조명 개수가 바뀔 때마다 Three.js가
// 모든 머티리얼 셰이더를 재컴파일해 프레임이 멎는다(보스 탄막 시 치명적 렉).
// → 조명 개수를 절대 바꾸지 않도록 고정 풀을 미리 만들고, 매 프레임 가장 중요한
//   발광 투사체들에 위치/색/밝기만 재배정한다(미사용 조명은 intensity=0).
const LIGHT_POOL_N = 8;
const LIGHT_POOL = [];
for (let i = 0; i < LIGHT_POOL_N; i++) { const l = new THREE.PointLight(0xffffff, 0, 12); l.castShadow = false; scene.add(l); LIGHT_POOL.push(l); }
const _lightCands = [];   // 매 프레임 재사용하는 후보 배열
// projectiles/meteors에서 발광 후보를 모아 우선순위(밝기*가중)로 상위 N개에 조명 배정
function updateProjectileLights() {
  _lightCands.length = 0;
  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i];
    if (!p.li) continue;                         // li = {c,i,d,w} 조명 정보
    _lightCands.push(p);
  }
  for (let i = 0; i < meteors.length; i++) { const m = meteors[i]; if (m.delay > 0) continue; _lightCands.push(m); }
  // 우선순위: 가중치 높은 것 우선(메테오/화염구 > 볼트 > 화살)
  _lightCands.sort((a, b) => (b.li.w || 1) - (a.li.w || 1));
  const n = Math.min(LIGHT_POOL_N, _lightCands.length);
  for (let i = 0; i < LIGHT_POOL_N; i++) {
    const l = LIGHT_POOL[i];
    if (i < n) {
      const c = _lightCands[i], li = c.li, pos = c.mesh.position;
      l.position.set(pos.x, pos.y, pos.z);
      l.color.setHex(li.c); l.distance = li.d || 12;
      l.intensity = li.i * (li.flicker ? (0.85 + Math.random() * 0.35) : 1);
    } else l.intensity = 0;
  }
}

// ---------- 지형 높이 함수 (지형 메시 + 캐릭터 접지 공용) ----------
const WORLD = 240;          // 지형 한 변 길이
const WATER_Y = -1.2;
function terrainHeight(x, z) {
  let h = 0;
  h += Math.sin(x * 0.035) * Math.cos(z * 0.03) * 6.0;
  h += Math.sin(x * 0.012 + 1.7) * 4.5;
  h += Math.cos(z * 0.016 + 0.4) * 4.0;
  h += Math.sin((x + z) * 0.06) * 1.2;
  // 가장자리를 살짝 낮춰 분지처럼
  const d = Math.sqrt(x * x + z * z) / (WORLD * 0.5);
  h -= Math.max(0, d - 0.7) * 18;
  return h;
}

// ---------- 지형 (지오메트리는 1회 생성, 머티리얼·식생은 바이옴마다 교체) ----------
const _texLoader = new THREE.TextureLoader();
const _texCache = {};
function loadTex(name) {
  if (_texCache[name]) return _texCache[name];
  const map = _texLoader.load(`assets/textures/${name}_diff.jpg`);
  const nor = _texLoader.load(`assets/textures/${name}_nor_gl.jpg`);
  const rgh = _texLoader.load(`assets/textures/${name}_rough.jpg`);
  [map, nor, rgh].forEach((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(45, 45); t.anisotropy = 4; });
  map.colorSpace = THREE.SRGBColorSpace;
  _texCache[name] = { map, nor, rgh };
  return _texCache[name];
}
const _matCache = {};
function biomeMat(b) {
  const key = b.tex + "_" + b.tint;
  if (_matCache[key]) return _matCache[key];
  const t = loadTex(b.tex);
  _matCache[key] = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.nor, roughnessMap: t.rgh, color: b.tint || 0xffffff, roughness: 1, metalness: 0 });
  return _matCache[key];
}

function makeTerrainGeo() {
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, 200, 200);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  return geo;
}
const terrainMesh = new THREE.Mesh(makeTerrainGeo(), new THREE.MeshStandardMaterial({ color: 0x808080 }));
terrainMesh.receiveShadow = true;
scene.add(terrainMesh);
const waterMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD, WORLD),
  new THREE.MeshStandardMaterial({ color: 0x2f6f9e, transparent: true, opacity: 0.72, roughness: 0.2, metalness: 0.3 })
);
waterMesh.rotation.x = -Math.PI / 2; waterMesh.position.y = WATER_Y; scene.add(waterMesh);

const propGroup = new THREE.Group(); scene.add(propGroup);   // 바이옴 식생/바위(층마다 교체)
const obstacles = [];     // 솔리드 장애물(바위/나무) — 투사체 차폐용 {x,z,r,h}
let NP = null;            // 식생 프로토타입 모음(로드 후 채움)
let playerLight = null;   // 동굴/용암용 플레이어 주변 광원
const dungeon = createDungeon({ scene, terrainHeight, WORLD });   // 폐쇄형 바이옴의 벽/천장/충돌

// ---------- GLB 식생/바위 산포 (Quaternius CC0) ----------
// 각 GLB의 변형 메시를 프로토타입으로 추출해 목표 높이로 정규화한다(비스킨드 정적 메시).
function makePrototypes(gltf, targetH) {
  const protos = [];
  gltf.scene.updateMatrixWorld(true);
  // 변형 '노드' 단위로 추출한다(줄기+잎이 한 노드의 두 메시이므로 노드째 떠야 분리되지 않는다).
  let roots = gltf.scene.children;
  while (roots.length === 1 && !roots[0].isMesh && roots[0].children.length) roots = roots[0].children;
  roots.forEach((node) => {
    let hasMesh = false; node.traverse((o) => { if (o.isMesh) hasMesh = true; });
    if (!hasMesh) return;
    // 노드 전체를 복제하고 월드 변환(루트 Z-up→Y-up 회전·스케일 포함)을 그대로 구워 방향 보존
    const proto = node.clone();
    proto.position.set(0, 0, 0); proto.quaternion.identity(); proto.scale.set(1, 1, 1);
    proto.applyMatrix4(node.matrixWorld);
    proto.traverse((o) => { if (o.isMesh && o.material) { o.material.metalness = 0; o.material.roughness = 1; } });
    const wrap = new THREE.Group();
    wrap.add(proto);
    const box = new THREE.Box3().setFromObject(wrap);
    const size = new THREE.Vector3(); box.getSize(size);
    const c = new THREE.Vector3(); box.getCenter(c);
    proto.position.x -= c.x; proto.position.z -= c.z; proto.position.y -= box.min.y;  // 바닥을 원점에
    wrap.userData.norm = size.y > 0.0001 ? targetH / size.y : 1;
    protos.push(wrap);
  });
  return protos;
}
function scatterFrom(protos, count, opts) {
  if (!protos.length) return;
  opts = opts || {};
  const minH = opts.minH != null ? opts.minH : WATER_Y + 0.6;
  const maxH = opts.maxH != null ? opts.maxH : 12;
  const sMin = opts.sMin || 0.8, sMax = opts.sMax || 1.3;
  const cast = opts.cast !== false;
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 8) {
    tries++;
    const x = THREE.MathUtils.randFloatSpread(WORLD * 0.92);
    const z = THREE.MathUtils.randFloatSpread(WORLD * 0.92);
    const y = terrainHeight(x, z);
    if (y < minH || y > maxH) continue;
    if (Math.hypot(x, z) < 11) continue;               // 마을 중심은 비워둔다
    const proto = protos[(Math.random() * protos.length) | 0];
    const m = proto.clone();
    const rs = THREE.MathUtils.randFloat(sMin, sMax);
    m.scale.multiplyScalar(proto.userData.norm * rs);
    m.position.set(x, y - 0.05, z);
    if (opts.solid) obstacles.push({ x, z, r: (opts.cr || 0.8) * rs, h: (opts.ch || 6) * rs });   // 투사체 차폐 등록
    m.rotation.y = Math.random() * Math.PI * 2;
    m.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = cast; o.receiveShadow = true;
      if (opts.emissive != null) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(opts.emissive); o.material.emissiveIntensity = 1.3; }
    });
    propGroup.add(m);
    placed++;
  }
}

// 애니메이션 클립 별칭 (KayKit Knight/Skeleton 공통 클립명)
const CLIP = { idle: "Idle", walk: "Walking_A", run: "Running_A", jump: "Jump_Idle", attack: "1H_Melee_Attack_Slice_Diagonal", death: "Death_A", hit: "Hit_A" };

// ---------- 입력 ----------
const keys = {};
addEventListener("keydown", (e) => { keys[e.code] = true; if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault(); });
addEventListener("keyup", (e) => { keys[e.code] = false; });

// 카메라 궤도 + 클릭 공격 구분
const cam = { yaw: 0, pitch: 0.35, dist: 8 };
let camReady = false;
// 이동 시 카메라 자동 추적: 전진(W 성분) 이동 중 카메라가 진행 방향 뒤로 부드럽게 따라온다.
// 수동 드래그/터치로 시점을 돌리면 CAM_MANUAL_GRACE초 동안 자동추적을 멈춰 조준을 방해하지 않는다.
const AUTO_FOLLOW_CAM = true;     // 자동 추적 끄려면 false
const CAM_FOLLOW_RATE = 7.0;      // 클수록 빨리 따라옴(작을수록 느슨한 트레일)
const CAM_MANUAL_GRACE = 1.0;     // 수동(우클릭) 회전 후 자동추적 양보 시간(초)
let camManualT = 0;
let dragging = false, dragMoved = 0, downT = 0, downX = 0, downY = 0;
const el = renderer.domElement;
el.addEventListener("contextmenu", (e) => e.preventDefault());   // 우클릭 메뉴 방지(시점 드래그용)
el.addEventListener("mousedown", (e) => {
  if (e.button === 2) {                                          // 우클릭 = 시점 회전 드래그
    dragging = true; dragMoved = 0; downX = e.clientX; downY = e.clientY; return;
  }
  if (e.button === 0) downT = performance.now();                 // 좌클릭 = 공격(타이밍 기록)
});
addEventListener("mouseup", (e) => {
  if (e.button === 2) { dragging = false; return; }              // 시점 드래그 종료
  if (e.button === 0 && performance.now() - downT < 400) attack();   // 좌클릭 = 공격
});
// 클래스 스킬(패링/구르기/블링크)은 F 키. 우클릭은 시점 회전. 1·2·3·4는 보스 보상 액티브 스킬.
// (이전엔 Q·W·E·R이었으나 W가 전진 이동키와 겹쳐 1~4 숫자키로 옮김. 드래프트 1·2·3 선택과는
//  castActive의 paused 가드로 충돌하지 않는다.)
const ACTIVE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code in ACTIVE_KEYS) castActive(ACTIVE_KEYS[e.code]);
  else if (e.code === "KeyF") skillDown();   // 무빙기(클래스 스킬): F 키 / 우클릭
});
addEventListener("mousemove", (e) => {
  if (!dragging) return;
  dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
  cam.yaw -= e.movementX * 0.004;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + e.movementY * 0.004, -0.2, 1.2);
  camManualT = CAM_MANUAL_GRACE;   // 수동 회전 중엔 자동추적 양보
});
el.addEventListener("wheel", (e) => { cam.dist = THREE.MathUtils.clamp(cam.dist + e.deltaY * 0.01, 4, 18); e.preventDefault(); }, { passive: false });
// 터치(간단)
el.addEventListener("touchstart", (e) => { dragging = true; dragMoved = 0; const t = e.touches[0]; downX = t.clientX; downY = t.clientY; }, { passive: true });
addEventListener("touchmove", (e) => { if (!dragging) return; const t = e.touches[0]; cam.yaw -= (t.clientX - downX) * 0.01; cam.pitch = THREE.MathUtils.clamp(cam.pitch + (t.clientY - downY) * 0.01, -0.2, 1.2); downX = t.clientX; downY = t.clientY; camManualT = CAM_MANUAL_GRACE; }, { passive: true });
addEventListener("touchend", () => { dragging = false; });

// ---------- 플레이어 / 애니메이션 ----------
let player = null, mixer = null;
const actions = {};
let curAction = null, oneShot = null;
let atkAdd = null, attackSlow = 0;   // 가산(상체) 공격 액션 / 공격 시 잠깐 감속
// 클래스 스킬 상태: 패링 창(parryWindow) / 무적프레임(iframes) / 쿨다운 / 구르기 대시
let parryWindow = 0, iframes = 0, skillCd = 0, dashTime = 0;
const dashDir = new THREE.Vector3();
let grappleT = 0, grappleDur = 0.55;                 // 갈고리 이동(궁수)
const grappleFrom = new THREE.Vector3(), grappleTo = new THREE.Vector3();
// 기본 공격 제약: 클래스별 공격속도(쿨다운)만 사용
let playerAtkCd = 0;
let paused = false, pendingLv = 0;   // 레벨업 스킬 드래프트(일시정지·대기 횟수)
const vel = new THREE.Vector3();
let vy = 0, grounded = true;
const GRAV = -22, JUMP_V = 9;
let WALK = 6, RUN = 10;   // 캐릭터 선택 시 갱신

function fade(name, dur = 0.2) {
  const next = actions[name];
  if (!next || curAction === next) return;
  if (curAction) curAction.fadeOut(dur);
  next.reset().fadeIn(dur).play();
  curAction = next;
}
function playOnce(name, then) {
  const a = actions[name]; if (!a) return;
  if (curAction) curAction.fadeOut(0.1);
  a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.fadeIn(0.1).play();
  oneShot = { action: a, then };
  curAction = a;
}
// ---------- 게임 진행 상태 / 전투 ----------
const GAME = { hp: 130, maxHp: 130, xp: 0, xpNext: 100, level: 1, gold: 0, dead: false, floor: 1, started: false, actives: [null, null, null, null] };
let playerShield = 0, buffT = 0;   // 액티브: 방패(피해 무효) / 광폭화 버프
let world = null, charScale = 1, monstersRef = null;
let PSTATS = { dmg: 12, attackWindup: 240 };   // 선택한 캐릭터 스탯
UI.init();

const _aim = new THREE.Vector3();
function aimDir() {   // 카메라가 보는 수평 방향(화면 안쪽)으로 조준
  _aim.subVectors(player.position, camera.position); _aim.y = 0;
  if (_aim.lengthSq() < 1e-4) _aim.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  return _aim.normalize();
}
// ---------- 클래스 스킬 (우클릭 / Q) ----------
function skillDown() {
  if (!player || GAME.dead || skillCd > 0) return;
  const s = PSTATS.skill;
  if (s === "parry") doParry();
  else if (s === "dodge") doDodge();
  else if (s === "blink") doBlink();
}
function skillUp() { /* 탭형 스킬만 사용(hold 없음) */ }
function doParry() {
  skillCd = 0.7; parryWindow = 0.4;                  // 0.4초 패링 창
  if (actions[PSTATS.skillClip]) playOnce(PSTATS.skillClip, null);
}
function doDodge() {
  skillCd = 1.2 * PSTATS.skillCdMult; iframes = 0.45;   // 짧은 무적
  dashDir.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  dashTime = 0.32;
  if (actions[PSTATS.skillClip]) playOnce(PSTATS.skillClip, null);
}
function doBlink() {
  skillCd = 3.0 * PSTATS.skillCdMult; iframes = 0.3;
  // 방향: WASD 입력이 있으면 그 방향(카메라 기준), 없으면 시선 방향 — 적에게 끌려가지 않음
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz -= 1; if (keys.KeyS || keys.ArrowDown) iz += 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1; if (keys.KeyD || keys.ArrowRight) ix += 1;
  let dir;
  if (ix !== 0 || iz !== 0) { const ang = Math.atan2(ix, iz) + cam.yaw; dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)); }
  else dir = aimDir().clone();
  player.rotation.y = Math.atan2(dir.x, dir.z);
  const lim = WORLD * 0.46;
  const nx = THREE.MathUtils.clamp(player.position.x + dir.x * 7, -lim, lim);
  const nz = THREE.MathUtils.clamp(player.position.z + dir.z * 7, -lim, lim);
  spawnExplosion(player.position.clone().setY(player.position.y + 1), 1.3);   // 출발 연출
  player.position.set(nx, terrainHeight(nx, nz), nz); camReady = false;
  spawnExplosion(player.position.clone().setY(player.position.y + 1), 1.3);   // 도착 연출
  if (actions[PSTATS.skillClip]) playOnce(PSTATS.skillClip, null);
}

function attack() {
  if (!player || GAME.dead || playerAtkCd > 0) return;
  playerAtkCd = PSTATS.atkInterval * (buffT > 0 ? 0.55 : 1);   // 광폭화 시 공속↑
  // 자동 조준(소프트 락온): 가까운 적을 향해 캐릭터를 돌려 발사 → 맞히기 쉬움
  const target = world ? world.nearestEnemy(player.position, PSTATS.atkType === "melee" ? (PSTATS.meleeReach || 3.4) + 1.2 : 36) : null;
  if (target) { const tp = target.obj.position; player.rotation.y = Math.atan2(tp.x - player.position.x, tp.z - player.position.z); }
  if (atkAdd) { atkAdd.stop(); atkAdd.reset(); atkAdd.setEffectiveWeight(1); atkAdd.timeScale = 1.3; atkAdd.play(); }
  else playOnce(CLIP.attack, null);
  attackSlow = 0.22;
  const crit = Math.random() < (PSTATS.critChance || 0.2);
  const dmg = Math.round((PSTATS.dmg + (GAME.level - 1) * 2) * (crit ? 1.7 + (PSTATS.critMult || 0) : 1) * (buffT > 0 ? 2 : 1));
  if (PSTATS.atkType === "melee") {
    setTimeout(() => { if (world && !GAME.dead) world.playerAttack(dmg, crit, PSTATS.meleeReach); }, PSTATS.attackWindup);
  } else {
    const type = PSTATS.atkType, shots = 1 + (PSTATS.extraShots || 0);
    // 3D 조준: 점프 중이면 적을 향해 아래/위로도 날아가도록 y성분 포함
    let base;
    if (target) {
      const o = player.position.clone(); o.y += 1.3;
      const tp = target.obj.position.clone(); tp.y += 1.0;
      base = tp.sub(o).normalize();
    } else {
      const ang = player.rotation.y; base = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
    }
    setTimeout(() => {
      if (!world || GAME.dead) return;
      const spread = type === "fireball" ? 0.06 : 0.13;   // 화염구는 확산을 좁혀 근접 시 모두 명중
      for (let i = 0; i < shots; i++) {
        const a = (i - (shots - 1) / 2) * spread, c = Math.cos(a), s = Math.sin(a);  // Y축 회전(피치 유지)
        spawnProjectile(type, new THREE.Vector3(base.x * c + base.z * s, base.y, -base.x * s + base.z * c), dmg, crit);
      }
    }, PSTATS.attackWindup);
  }
}

// ---------- VFX 텍스처 / 스프라이트 시스템 (CC0/MIT) ----------
function _vt(name) { const t = _texLoader.load("assets/vfx/" + name); t.colorSpace = THREE.SRGBColorSpace; return t; }
// 밝은 중심의 글로우/링 텍스처를 캔버스로 생성(가산혼합용) — 받은 렌즈플레어는 RGB가 어두워 부적합
function _canvasTex(draw, size) { const c = document.createElement("canvas"); c.width = c.height = size || 128; draw(c.getContext("2d")); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
// 스킬/이펙트 스프라이트 — 전부 외부 CC0 소스(Kenney Particle Pack)에서 로드(런타임 생성 안 함)
const TEX = {
  glow:  _vt("kenney/circle_05.png"),   // 부드러운 발광(머즐/코어/트레일/원소 빛)
  ring:  _vt("kenney/circle_04.png"),   // 충격파 링/지면 데칼
  spark: _vt("kenney/star_08.png"),     // 타격 스파크/별 폭발
  smoke: _vt("kenney/smoke_05.png"),    // 연기(독/그을림)
  disc:  _vt("kenney/light_02.png"),    // 후광 디스크(파이어볼 등)
  star:  _vt("kenney/star_06.png"),     // 반짝임
  magic: _vt("kenney/magic_01.png"),    // 마법진(룬 데칼)
  slash: _vt("kenney/slash_03.png"),    // 참격
  bolt:  _vt("kenney/spark_04.png"),    // 전격/번개 크랙
};
function glowSprite(tex, color, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size); return s;
}
// 일회성 스프라이트 플래시(폭발 코어/충격파/연기/머즐): 크기 a→b, 페이드아웃
const fxSprites = [];
function spriteFlash(pos, tex, color, a, b, dur, blend, spin) {
  const s = glowSprite(tex, color, a);
  if (blend === "normal") { s.material.blending = THREE.NormalBlending; }
  s.position.copy(pos); s.material.rotation = Math.random() * Math.PI; scene.add(s);
  fxSprites.push({ s, t: 0, dur, a, b, spin: spin || 0 });
}
function updateFxSprites(dt) {
  for (let i = fxSprites.length - 1; i >= 0; i--) {
    const f = fxSprites[i]; f.t += dt; const k = f.t / f.dur;
    f.s.scale.setScalar(f.a + (f.b - f.a) * k);
    f.s.material.opacity = Math.max(0, 1 - k);
    if (f.spin) f.s.material.rotation += f.spin * dt;
    if (f.t >= f.dur) { scene.remove(f.s); f.s.material.dispose(); fxSprites.splice(i, 1); }
  }
}
// 텍스처 스파크(타격/폭발 시 사방으로 튀는 불꽃)
const sparks = [];
function spawnSparks(pos, color, n, spd) {
  for (let i = 0; i < n && sparks.length < 360; i++) {
    const s = glowSprite(TEX.spark, color, 0.5); s.position.copy(pos); scene.add(s);
    const a = Math.random() * Math.PI * 2, el = Math.random(), sp = spd * THREE.MathUtils.randFloat(0.5, 1.35);
    sparks.push({ s, v: new THREE.Vector3(Math.cos(a) * sp, (0.4 + el) * sp * 0.8, Math.sin(a) * sp), t: 0, dur: THREE.MathUtils.randFloat(0.3, 0.65) });
  }
}
function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i]; p.t += dt; const k = p.t / p.dur;
    p.s.position.addScaledVector(p.v, dt); p.v.multiplyScalar(0.87); p.v.y -= 15 * dt;
    p.s.material.opacity = Math.max(0, 1 - k); p.s.scale.setScalar(0.5 * (1 - 0.5 * k));
    if (p.t >= p.dur) { scene.remove(p.s); p.s.material.dispose(); sparks.splice(i, 1); }
  }
}
// 투사체 잔광 트레일(글로우 퍼프가 길게 늘어지며 사라짐)
const trails = [];
function spawnTrailPuff(pos, color, size, life, tex) {
  if (trails.length > 320) return;
  const s = glowSprite(tex || TEX.glow, color, size); s.position.copy(pos); scene.add(s);
  trails.push({ s, t: 0, dur: life || 0.3, size });
}
function updateTrails(dt) {
  for (let i = trails.length - 1; i >= 0; i--) {
    const tr = trails[i]; tr.t += dt; const k = tr.t / tr.dur;
    tr.s.material.opacity = Math.max(0, 0.9 * (1 - k)); tr.s.scale.setScalar(tr.size * (1 - 0.45 * k));
    if (tr.t >= tr.dur) { scene.remove(tr.s); tr.s.material.dispose(); trails.splice(i, 1); }
  }
}

// ===== 추가 연출: 마법진 데칼 / 상승 잉걸불 / 화면 섬광 =====
// 룬 마법진 텍스처(캔버스): 이중 링 + 눈금 + 십자
// 바닥에 눕는 평면 데칼(마법진/그을림/서리 자국) — 카메라 빌보드가 아니라 지면 평행
const decals = [];
const _decalGeo = new THREE.PlaneGeometry(1, 1);
function spawnDecal(pos, radius, color, tex, dur, spin, grow) {
  const m = new THREE.Mesh(_decalGeo, new THREE.MeshBasicMaterial({ map: tex || TEX.ring, color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(pos.x, terrainHeight(pos.x, pos.z) + 0.08, pos.z);
  m.scale.setScalar(radius * 2); scene.add(m);
  decals.push({ m, t: 0, dur: dur || 0.8, spin: spin || 0, base: radius * 2, grow: grow || 0 });
}
// 룬 마법진 데칼: 궁수는 마법진이 어울리지 않아 생략(대신 단순 충격 링만)
function runeDecal(pos, radius, color, dur, spin, grow) {
  if (PSTATS && PSTATS.cls === "archer") return;
  spawnDecal(pos, radius, color, TEX.magic, dur, spin, grow);
}
function updateDecals(dt) {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i]; d.t += dt; const k = d.t / d.dur;
    if (d.spin) d.m.rotation.z += d.spin * dt;
    if (d.grow) d.m.scale.setScalar(d.base * (1 + d.grow * k));
    d.m.material.opacity = 0.95 * (1 - k * k);
    if (d.t >= d.dur) { scene.remove(d.m); d.m.material.dispose(); decals.splice(i, 1); }
  }
}
// 상승 잉걸불(불/마법 폭발 시 위로 떠오르는 불티)
const embers = [];
function spawnEmbers(pos, color, n, spread, rise) {
  for (let i = 0; i < n && embers.length < 360; i++) {
    const s = glowSprite(TEX.glow, color, 0.5); const a = Math.random() * 6.283, rr = Math.random() * (spread || 2);
    s.position.set(pos.x + Math.cos(a) * rr, pos.y + Math.random() * 0.5, pos.z + Math.sin(a) * rr); scene.add(s);
    embers.push({ s, vy: (rise || 4) * (0.6 + Math.random() * 0.8), vx: (Math.random() - 0.5) * 1.5, vz: (Math.random() - 0.5) * 1.5, t: 0, dur: 0.7 + Math.random() * 0.7, sz: 0.3 + Math.random() * 0.4 });
  }
}
function updateEmbers(dt) {
  for (let i = embers.length - 1; i >= 0; i--) {
    const p = embers[i]; p.t += dt; const k = p.t / p.dur;
    p.s.position.x += p.vx * dt; p.s.position.z += p.vz * dt; p.s.position.y += p.vy * dt; p.vy *= 0.96;
    p.s.material.opacity = Math.max(0, 1 - k); p.s.scale.setScalar(p.sz * (1 - 0.4 * k));
    if (p.t >= p.dur) { scene.remove(p.s); p.s.material.dispose(); embers.splice(i, 1); }
  }
}
// ===== 무료 애니메이션 스프라이트시트 VFX (실제 다운로드 에셋) =====
// sheet_explosion.png: 320x320, 64px 프레임, 5열×5행, 23프레임 화염 폭발(Phaser 예제 에셋)
const TEX_EXPLO = _vt("sheet_explosion.png");
const anims = [];
function spawnAnim(pos, o) {
  if (anims.length > 28) return;   // 성능 가드(폭발 동시 과다 방지)
  const tex = TEX_EXPLO.clone(); tex.needsUpdate = true; tex.repeat.set(1 / o.cols, 1 / o.rows);
  const mat = new THREE.SpriteMaterial({ map: tex, color: o.color || 0xffffff, transparent: true, depthWrite: false, blending: o.blend === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending });
  const s = new THREE.Sprite(mat); s.scale.setScalar(o.size); s.position.copy(pos); scene.add(s);
  anims.push({ s, tex, t: 0, dur: o.dur || 0.55, frames: o.frames, cols: o.cols, rows: o.rows });
}
function updateAnims(dt) {
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i]; a.t += dt; const k = a.t / a.dur;
    const f = Math.min(a.frames - 1, Math.floor(k * a.frames));
    a.tex.offset.set((f % a.cols) / a.cols, 1 - (Math.floor(f / a.cols) + 1) / a.rows);
    if (a.t >= a.dur) { scene.remove(a.s); a.s.material.dispose(); a.tex.dispose(); anims.splice(i, 1); }
  }
}
// 화염 폭발 애니메이션(원소 색 틴트 가능) — pos 중심
function animExplosion(pos, size, color, dur) { spawnAnim(pos, { cols: 5, rows: 5, frames: 23, size, color, dur: dur || 0.55, blend: "add" }); }
// 화면 전체 색 섬광(DOM 오버레이) — 강력한 스킬 시 번쩍
let _flashEl = null;
function screenFlash(color, alpha, dur) {
  if (!_flashEl) { _flashEl = document.createElement("div"); _flashEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:50;opacity:0;transition:opacity 90ms ease-out;mix-blend-mode:screen"; document.body.appendChild(_flashEl); }
  _flashEl.style.background = color; _flashEl.style.opacity = String(alpha);
  setTimeout(() => { if (_flashEl) { _flashEl.style.transition = "opacity " + (dur || 280) + "ms ease-out"; _flashEl.style.opacity = "0"; } }, 60);
}

// ---------- 투사체(파이어볼/화살) ----------
const projectiles = [];
const fx = [];
const _fireballCoreGeo = new THREE.SphereGeometry(0.26, 10, 10);
const _arrowGeo = new THREE.CylinderGeometry(0.04, 0.06, 1.15, 6);
const _boltGeo = new THREE.SphereGeometry(0.2, 8, 8);
const _boltMat = new THREE.MeshBasicMaterial({ color: 0xe2c6ff });
const _fireballCoreMat = new THREE.MeshBasicMaterial({ color: 0xffe1ad });
const _arrowMat = new THREE.MeshStandardMaterial({ color: 0xeaf2fb, metalness: 0.6, roughness: 0.35, emissive: 0x2a4f6b, emissiveIntensity: 0.6 });
function spawnProjectile(type, dir, dmg, crit) {
  const origin = player.position.clone(); origin.y += 1.3; origin.addScaledVector(dir, 0.8);
  const g = new THREE.Group(); let hitR, aoe = 0, trail, li;
  if (type === "fireball") {
    g.add(new THREE.Mesh(_fireballCoreGeo, _fireballCoreMat));
    g.add(glowSprite(TEX.glow, 0xff7b2e, crit ? 2.8 : 2.3));
    g.add(glowSprite(TEX.disc, 0xffc25e, 1.15));
    li = { c: 0xff7b2e, i: 7, d: 12, w: 4, flicker: true };   // 조명 풀 정보(개별 PointLight 생성 안 함)
    hitR = 1.0; aoe = PSTATS.aoe || 3.2;
    trail = { tex: TEX.glow, color: 0xff8a2e, size: 1.5, life: 0.34, rate: 0.012 };
    spriteFlash(origin, TEX.glow, 0xffb060, 0.6, 1.8, 0.13);          // 머즐 플래시
  } else {
    const shaft = new THREE.Mesh(_arrowGeo, _arrowMat);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); g.add(shaft);
    g.add(glowSprite(TEX.glow, crit ? 0xfff0a0 : 0x9fe8ff, crit ? 1.3 : 1.0));
    li = { c: crit ? 0xfff0a0 : 0x9fe8ff, i: 2.2, d: 6, w: 1 };
    hitR = 0.8;
    trail = { tex: TEX.glow, color: crit ? 0xffe27a : 0x8fd8ff, size: 0.75, life: 0.24, rate: 0.009 };
    spriteFlash(origin, TEX.glow, 0xbfeaff, 0.4, 1.2, 0.1);
  }
  g.position.copy(origin); scene.add(g);
  projectiles.push({ mesh: g, vel: dir.clone().multiplyScalar(PSTATS.projSpeed), dmg, crit, type, hitR, aoe, life: 2.6, owner: "player", pierce: PSTATS.pierce || 0, hitSet: new Set(), trail, _tacc: 0, li });
}
// 적 투사체(원거리 술사/대마법사 볼트) — 플레이어를 향해
const ENEMY_PROJ_CAP = 80;     // 탄막 폭주 방지(렉 가드)
function spawnEnemyProjectile(origin, dir, dmg) {
  let cnt = 0; for (let i = 0; i < projectiles.length; i++) if (projectiles[i].owner === "enemy") cnt++;
  if (cnt >= ENEMY_PROJ_CAP) return;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(_boltGeo, _boltMat));
  g.add(glowSprite(TEX.glow, 0xb86bff, 1.7));
  g.position.set(origin.x, origin.y, origin.z); scene.add(g);
  const v = new THREE.Vector3(dir.x, dir.y || 0, dir.z); if (v.lengthSq() < 1e-6) v.set(0, 0, 1); v.normalize().multiplyScalar(26);
  projectiles.push({ mesh: g, vel: v, dmg, type: "bolt", hitR: 0.95, aoe: 0, life: 3.0, owner: "enemy", trail: { tex: TEX.glow, color: 0xb86bff, size: 1.0, life: 0.26, rate: 0.013 }, _tacc: 0, li: { c: 0xb86bff, i: 3, d: 7, w: 2 } });
}
// ---------- 파티클 버스트 / 화면 흔들림 ----------
const _burstGeo = new THREE.SphereGeometry(1, 6, 6);
const bursts = [];
function spawnBurst(pos, color, n, spd, size, life) {
  n = n || 10; spd = spd || 7; size = size || 0.16; life = life || 0.5;
  if (bursts.length > 240) return;
  const mat = new THREE.MeshBasicMaterial({ color: color || 0xffffff, transparent: true });
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(_burstGeo, mat);
    m.scale.setScalar(size * THREE.MathUtils.randFloat(0.6, 1.4));
    m.position.copy(pos);
    const a = Math.random() * Math.PI * 2, sp = spd * THREE.MathUtils.randFloat(0.5, 1.3);
    m.userData = { v: new THREE.Vector3(Math.cos(a) * sp, THREE.MathUtils.randFloat(0.3, 1) * sp * 0.7, Math.sin(a) * sp), life: life, max: life, mat: mat };
    scene.add(m); bursts.push(m);
  }
}
function updateBursts(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const m = bursts[i], u = m.userData;
    m.position.addScaledVector(u.v, dt); u.v.multiplyScalar(0.9); u.v.y -= 10 * dt;
    u.life -= dt; u.mat.opacity = Math.max(0, u.life / u.max);
    if (u.life <= 0) { scene.remove(m); bursts.splice(i, 1); }
  }
}
let shakeT = 0, shakeMag = 0;
function addShake(a) { shakeMag = Math.min(2.0, Math.max(shakeMag, a)); shakeT = Math.max(shakeT, 0.25); }
let hitstop = 0;   // 타격 순간 게임을 아주 잠깐 멈춰 묵직함을 줌
function addHitstop(s) { hitstop = Math.max(hitstop, s); }

// 스킬/보스 전용 VFX 상태
const bolts = [];      // 번개 라인
const meteors = [];    // 낙하 운석
const warns = [];      // 보스 텔레그래프 경고 링
let exposureMul = 1, exposureT = 0;   // 화면 암전 펄스(메테오 등)
function darkenPulse(mul, secs) { exposureMul = mul; exposureT = secs; }

function spawnBolt(from, to, color) {
  const seg = 8, pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, j = (i > 0 && i < seg) ? 1.3 : 0;
    pts.push(new THREE.Vector3(
      from.x + (to.x - from.x) * t + (Math.random() - 0.5) * j,
      from.y + (to.y - from.y) * t + (Math.random() - 0.5) * j,
      from.z + (to.z - from.z) * t + (Math.random() - 0.5) * j));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const m = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: color || 0xbfe6ff, transparent: true, opacity: 1 }));
  scene.add(m); bolts.push({ mesh: m, geo: geo, life: 0.18, max: 0.18 });
}
function updateBolts(dt) {
  for (let i = bolts.length - 1; i >= 0; i--) { const b = bolts[i]; b.life -= dt; b.mesh.material.opacity = Math.max(0, b.life / b.max); if (b.life <= 0) { scene.remove(b.mesh); b.geo.dispose(); bolts.splice(i, 1); } }
}
// 연쇄 번개: 플레이어 → 가까운 적들 차례로 번개 + 피해
function chainLightning(dmg, n) {
  if (!world) return;
  const list = world.enemies.filter((e) => !e.dead).sort((a, b) => a.obj.position.distanceTo(player.position) - b.obj.position.distanceTo(player.position)).slice(0, n);
  let from = player.position.clone(); from.y += 1.2;
  list.forEach((e) => { const to = e.obj.position.clone(); to.y += 1.0; spawnBolt(from, to, 0xeaf6ff); spawnBolt(from, to, 0x9fd0ff); animExplosion(to, 3.0, 0xbfe0ff, 0.4); spriteFlash(to, TEX.glow, 0xcfeaff, 0.4, 1.8, 0.22); spawnSparks(to, 0xbfe6ff, 8, 10); world.applyDamage(e, dmg, false); if (world.applyStatus) world.applyStatus(e, "lightning", { dur: 2.5 }); from = to; });
  addShake(0.5);
}
// 메테오: 화면 암전 + 하늘에서 운석 낙하 + 착탄 폭발/광역
function meteorStrike(dmg, radius, count) {
  if (!world) return;
  darkenPulse(0.42, 1.1);
  const t = world.nearestEnemy(player.position, 45), center = t ? t.obj.position.clone() : player.position.clone();
  for (let i = 0; i < count; i++) {
    const ox = i === 0 ? 0 : (Math.random() - 0.5) * radius * 1.5, oz = i === 0 ? 0 : (Math.random() - 0.5) * radius * 1.5;
    const tx = center.x + ox, tz = center.z + oz, gy = terrainHeight(tx, tz);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff5a1e }));
    m.position.set(tx, gy + 36, tz); scene.add(m);
    meteors.push({ mesh: m, x: tx, z: tz, gy: gy, dmg: dmg, radius: radius, delay: i * 0.18, li: { c: 0xff7a2a, i: 6, d: 16, w: 5, flicker: true } });
  }
}
function updateMeteors(dt) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const mt = meteors[i];
    if (mt.delay > 0) { mt.delay -= dt; continue; }
    mt.mesh.position.y -= 62 * dt;
    if (mt.arrow) {                                                  // 화살(궁수): 화염 꼬리 대신 가벼운 잔광
      if (Math.random() < 0.4) spawnSparks(mt.mesh.position.clone(), 0xcfe0f5, 1, 4);
    } else {
      spawnTrailPuff(mt.mesh.position, 0xff7a2a, 1.6, 0.4, TEX.glow);   // 화염 꼬리(메테오)
      if (Math.random() < 0.5) spawnSparks(mt.mesh.position.clone(), 0xffb060, 2, 5);
    }
    if (mt.mesh.position.y <= mt.gy + 0.6) {
      const pos = new THREE.Vector3(mt.x, mt.gy + 0.5, mt.z);
      if (mt.arrow) {                                               // 화살 착탄: 작은 충격(불꽃폭발·흔들림 없음)
        fxRing(pos, mt.radius, 0xbcd4f0); spawnSparks(pos, 0xdfe9f5, 6, 7);
      } else {                                                      // 메테오 착탄: 불꽃 폭발 + 강한 흔들림
        spawnExplosion(pos, mt.radius); fxRing(pos, mt.radius, 0xff7a2a); spawnBurst(pos, 0x8a5030, 16, 11, 0.32, 0.7);
      }
      if (world) for (const e of world.enemies.slice()) if (!e.dead && e.obj.position.distanceTo(pos) < mt.radius + e.def.radius) { world.applyDamage(e, mt.dmg, true); if (!mt.arrow && world.applyStatus) world.applyStatus(e, "fire", { dur: 3, dps: Math.max(6, Math.round(mt.dmg * 0.1)) }); }
      if (!mt.arrow) addShake(1.0);                                 // 화살은 발마다 흔들지 않음(연속 착탄 시 시점 붕괴 방지)
      scene.remove(mt.mesh); meteors.splice(i, 1);
    }
  }
}
// 화살 비(궁수): 지정 지역에 화살이 쏟아져 다수 타격
function arrowRain(dmg, radius, count) {
  if (!world) return;
  const t = world.nearestEnemy(player.position, 45), c = t ? t.obj.position.clone() : player.position.clone();
  for (let i = 0; i < count; i++) {
    const tx = c.x + (Math.random() - 0.5) * radius * 1.7, tz = c.z + (Math.random() - 0.5) * radius * 1.7, gy = terrainHeight(tx, tz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 5), new THREE.MeshBasicMaterial({ color: 0xdfe9f5 }));
    m.position.set(tx, gy + 28, tz); scene.add(m);
    // arrow:true → updateMeteors가 화살용 가벼운 연출/착탄을 쓴다(메테오의 불꽃폭발·강한 흔들림 공유 금지).
    meteors.push({ mesh: m, x: tx, z: tz, gy: gy, dmg: dmg, radius: 2.0, delay: i * 0.05, arrow: true });
  }
  addShake(0.4);
}

// ========== 원소 스킬 VFX (빙결/눈보라/얼음회오리/태풍/시간정지/오라) ==========
// 시간 지속 파티클 이미터: 매 rate초마다 tick(e) 호출, dur초 후 종료
const emitters = [];
function addEmitter(o) { o.t = 0; o.acc = 0; emitters.push(o); return o; }
function updateEmitters(dt) {
  for (let i = emitters.length - 1; i >= 0; i--) {
    const e = emitters[i]; e.t += dt; e.acc += dt;
    if (e.follow && player) e.pos.copy(player.position);
    let guard = 0;
    while (e.acc >= e.rate && guard++ < 40) { e.acc -= e.rate; e.tick(e); }
    if (e.t >= e.dur) emitters.splice(i, 1);
  }
}
// 얼음 파편: 땅에서 솟구쳐 자랐다가 사라지는 결정
const shards = [];
const _shardGeo = new THREE.ConeGeometry(0.16, 1.0, 5);
function spawnIceShard(pos, scale) {
  if (shards.length > 160) return;
  const m = new THREE.Mesh(_shardGeo, new THREE.MeshStandardMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.9, emissive: 0x2f5f82, emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.1 }));
  m.position.copy(pos); m.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * Math.PI, (Math.random() - 0.5) * 0.5);
  m.scale.set(0.6, 0.05, 0.6); scene.add(m);
  shards.push({ m, t: 0, dur: 0.95, h: (0.9 + Math.random() * 0.9) * (scale || 1) });
}
function updateShards(dt) {
  for (let i = shards.length - 1; i >= 0; i--) {
    const s = shards[i]; s.t += dt; const k = s.t / s.dur;
    const grow = Math.min(1, k * 3.5);
    s.m.scale.set(0.6 + grow * 0.5, 0.05 + grow * s.h * 2.2, 0.6 + grow * 0.5);
    s.m.material.opacity = 0.9 * (1 - Math.max(0, (k - 0.45) / 0.55));
    if (s.t >= s.dur) { scene.remove(s.m); s.m.material.dispose(); shards.splice(i, 1); }
  }
}
function _gy(x, z) { return terrainHeight(x, z); }
function _skillCenter(range) { const t = world && world.nearestEnemy(player.position, range || 30); return t ? t.obj.position.clone() : player.position.clone(); }
// 빙결: 얼음 폭발 — 청록 섬광+충격파 링+얼음 파편+서리 모트+스파크
function frostNova(pos, radius, dur) {
  animExplosion(pos, radius * 2.6, 0x9fe6ff, 0.5);   // 애니메이션 폭발(서리 틴트)
  spriteFlash(pos, TEX.glow, 0xffffff, radius * 0.4, radius * 1.3, 0.16);
  spriteFlash(pos, TEX.glow, 0x9fdcff, radius * 0.6, radius * 2.1, 0.34);
  spriteFlash(pos, TEX.ring, 0xbdeeff, radius * 0.4, radius * 3.0, 0.6, null, 1.6);
  runeDecal(pos, radius * 1.1, 0x9fe0ff, 0.7, -2.5, 0.5);   // 서리 마법진
  fxRing(pos, radius, 0x88d4ff); screenFlash("rgba(150,220,255,0.32)", 0.32, 240);
  for (let i = 0; i < 22; i++) { const a = Math.random() * Math.PI * 2, rr = Math.random() * radius; const x = pos.x + Math.cos(a) * rr, z = pos.z + Math.sin(a) * rr; spawnIceShard(new THREE.Vector3(x, _gy(x, z) + 0.1, z), 1.2); }
  spawnSparks(pos, 0xd6f2ff, 22, 9);
  addEmitter({ pos: pos.clone(), dur: dur || 1.0, rate: 0.02, tick: (e) => { const a = Math.random() * Math.PI * 2, rr = Math.random() * radius * 1.3; spawnTrailPuff(new THREE.Vector3(e.pos.x + Math.cos(a) * rr, e.pos.y + 0.5 + Math.random() * 2.6, e.pos.z + Math.sin(a) * rr), 0xcfeeff, 0.9, 0.7, TEX.glow); } });
  addShake(0.5);
}
// 눈보라: 넓은 범위에 연속 서리 폭발 + 휘몰아치는 눈 입자
function blizzard(pos, radius, dur) {
  frostNova(pos, radius, dur);
  addEmitter({ pos: pos.clone(), dur: dur || 2.5, rate: 0.06, tick: (e) => {
    const a = Math.random() * Math.PI * 2, rr = Math.random() * radius; const x = e.pos.x + Math.cos(a) * rr, z = e.pos.z + Math.sin(a) * rr;
    spawnTrailPuff(new THREE.Vector3(x, _gy(x, z) + 0.5 + Math.random() * 3, z), 0xeaf6ff, 0.55, 0.6, TEX.glow);
    if (Math.random() < 0.25) spawnIceShard(new THREE.Vector3(x, _gy(x, z) + 0.1, z));
  } });
  addEmitter({ pos: pos.clone(), dur: dur || 2.5, rate: 0.4, tick: (e) => { const a = Math.random() * Math.PI * 2, rr = Math.random() * radius * 0.8; fxRing(new THREE.Vector3(e.pos.x + Math.cos(a) * rr, 0, e.pos.z + Math.sin(a) * rr), radius * 0.35, 0x9fe0ff); } });
}
// 얼음 회오리 / 태풍: 회전하며 위로 솟는 입자 기둥(원소 색상 지정)
function vortex(pos, radius, dur, color, dmg, dmgEvery) {
  spriteFlash(pos, TEX.ring, color, radius * 0.6, radius * 2.8, 0.6, null, 2.5);
  fxRing(pos, radius, color);
  runeDecal(pos, radius * 1.0, color, dur, 3.5, 0.15);   // 회전 마법진(지속)
  screenFlash("rgba(190,230,255,0.3)", 0.3, 240);
  let ang = 0, dmgAcc = 0; const baseY = _gy(pos.x, pos.z);
  addEmitter({ pos: pos.clone(), dur: dur, rate: 0.012, tick: (e) => {
    ang += 1.0; const turns = 4;
    for (let s = 0; s < turns; s++) {
      const aa = ang + s * (Math.PI * 2 / turns), h = (e.t * 1.6 % 1.0); const rr = radius * (0.3 + 0.7 * (1 - h));
      const x = e.pos.x + Math.cos(aa) * rr, z = e.pos.z + Math.sin(aa) * rr;
      spawnTrailPuff(new THREE.Vector3(x, baseY + 0.4 + h * radius * 1.9, z), color, 1.1, 0.45, TEX.glow);
    }
    spawnTrailPuff(new THREE.Vector3(e.pos.x, baseY + 0.5 + (e.t * 3 % 1) * radius * 1.9, e.pos.z), color, 1.6, 0.4, TEX.glow);   // 중심 기둥
    dmgAcc += e.rate;
    if (dmg && world && dmgAcc >= (dmgEvery || 0.4)) { dmgAcc = 0; for (const en of world.enemies.slice()) if (!en.dead && en.obj.position.distanceTo(e.pos) < radius + en.def.radius) { world.applyDamage(en, dmg, false); if (world.applyStatus) world.applyStatus(en, "ice", { dur: 2.5 }); } }
  } });
  addShake(0.6);
}
function iceTornado(dmg, radius, dur) {
  const c = _skillCenter(40); c.y = _gy(c.x, c.z);
  vortex(c, radius, dur, 0xbfe9ff, dmg, 0.35);
  frostNova(c, radius * 0.9, 0.6);
  if (world && world.stunNearby) world.stunNearby(c, radius, 1.5);
}
function typhoon(dmg, radius, dur) {
  const c = _skillCenter(40); c.y = _gy(c.x, c.z);
  vortex(c, radius, dur, 0xd9f0ff, dmg, 0.3);
  spawnSparks(c, 0xeaf6ff, 22, 12); addShake(1.0);
}
// 시간 정지: 푸른 섬광 + 천천히 도는 시계 링 + 정지 입자
function timeFreezeFx(radius) {
  const c = player.position.clone();
  darkenPulse(0.55, 1.2); screenFlash("rgba(180,195,255,0.45)", 0.45, 400);
  runeDecal(c, radius * 1.2, 0xbcc8ff, 1.2, 0.8, 0.1);   // 시계 마법진
  spriteFlash(c, TEX.glow, 0xbfd0ff, radius * 0.4, radius * 2.0, 0.6);
  spriteFlash(c, TEX.ring, 0xcdd8ff, radius * 0.3, radius * 2.8, 1.0, null, 0.7);
  spriteFlash(c, TEX.ring, 0xaab8ff, radius * 0.2, radius * 2.2, 1.0, null, -0.5);
  if (world) for (const e of world.enemies.slice()) if (!e.dead) { const p = e.obj.position.clone(); p.y += 1; spriteFlash(p, TEX.glow, 0x9fb6ff, 0.4, 1.6, 0.5); }
  addShake(0.4);
}
// 원소 광역 폭발(화염=따뜻한색/독=초록) — 섬광+링+스파크+(독)연기
function elementBurst(pos, radius, color, kind) {
  animExplosion(pos, radius * 2.8, kind === "poison" ? 0x9effa0 : kind === "fire" ? 0xffffff : color, 0.5);   // 애니메이션 폭발(원소 틴트)
  spriteFlash(pos, TEX.glow, 0xffffff, radius * 0.4, radius * 1.2, 0.15);
  spriteFlash(pos, TEX.glow, color, radius * 0.6, radius * 2.0, 0.34);
  spriteFlash(pos, TEX.ring, color, radius * 0.4, radius * 2.8, 0.52, null, 2);
  fxRing(pos, radius, color);
  runeDecal(pos, radius * 1.05, color, 0.6, kind === "poison" ? 1.5 : 3, 0.5);
  spawnSparks(pos, color, 18, 11);
  if (kind === "fire") spawnEmbers(pos, color, 12, radius * 0.6, 5);
  if (kind === "poison") for (let k = 0; k < 4; k++) { const sp = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * radius, Math.random() * radius * 0.5, (Math.random() - 0.5) * radius)); spriteFlash(sp, TEX.smoke, 0x4f7a2e, radius * 0.5, radius * 1.6, 0.85, "normal"); }
  screenFlash(kind === "poison" ? "rgba(150,230,110,0.28)" : "rgba(255,170,80,0.32)", 0.3, 240);
  addShake(0.6);
}
// 플레이어를 따라다니는 오라(보호막/광폭화) — secs 동안 회전 입자
function auraFollow(secs, color, up) {
  let ang = 0;
  addEmitter({ pos: player.position.clone(), follow: true, dur: secs, rate: 0.04, tick: (e) => {
    ang += 0.6; for (let s = 0; s < 2; s++) { const aa = ang + s * Math.PI; spawnTrailPuff(new THREE.Vector3(e.pos.x + Math.cos(aa) * 1.4, e.pos.y + 0.4 + (up ? (e.t * 2 % 2.2) : 1.0), e.pos.z + Math.sin(aa) * 1.4), color, 0.55, 0.4, TEX.glow); }
  } });
}

// ══════════ 신규 스킬 메커니즘 (다양성) ══════════
function _enemiesIn(pos, radius) { return world ? world.enemies.filter((e) => !e.dead && e.obj.position.distanceTo(pos) < radius + (e.def ? e.def.radius : 1)) : []; }
// 지속 피해 장판: dur초간 0.4s마다 광역 피해(화염/독/신성 등)
function dotZone(pos, radius, dps, dur, color, kind) {
  runeDecal(pos, radius, color, dur, kind === "poison" ? 1.0 : 2.5, 0.05);
  fxRing(pos, radius, color);
  addEmitter({ pos: pos.clone(), dur, rate: 0.08, tick: (e) => {
    const a = Math.random() * 6.283, rr = Math.random() * radius;
    spriteFlash(new THREE.Vector3(e.pos.x + Math.cos(a) * rr, _gy(e.pos.x, e.pos.z) + 0.3 + Math.random() * 1.5, e.pos.z + Math.sin(a) * rr),
      kind === "poison" ? TEX.smoke : TEX.glow, color, 0.6, 1.6, 0.5, kind === "poison" ? "normal" : null);
  } });
  let acc = 0;
  addEmitter({ pos: pos.clone(), dur, rate: 0.4, tick: (e) => { for (const en of _enemiesIn(e.pos, radius)) { world.applyDamage(en, Math.round(dps * 0.4), false); _applyElem(en, kind, dps); } } });
}
// 생명 흡수: 광역 피해 + 가한 피해의 일부 회복
function lifeDrain(radius, dmg, healFrac) {
  const c = player.position.clone(); let total = 0;
  const list = _enemiesIn(c, radius);
  for (const e of list) { world.applyDamage(e, dmg, false); total += dmg; const p = e.obj.position.clone(); p.y += 1; spawnBolt(player.position.clone().setY(player.position.y + 1.2), p, 0xc060ff); spawnSparks(p, 0xd080ff, 5, 7); }
  if (total > 0) { const heal = Math.round(total * (healFrac || 0.3)); GAME.hp = Math.min(GAME.maxHp, GAME.hp + heal); UI.setHP(GAME.hp, GAME.maxHp); onDamageNumber(player.position, 2.2, heal, "heal"); }
  spriteFlash(c.clone().setY(c.y + 1), TEX.glow, 0xc060ff, 1, 3, 0.4); addShake(0.4);
}
// 중력장: dur초간 적을 중심으로 끌어당김(+ 마무리 폭발)
function gravityWell(radius, dur, dmg) {
  const c = player.position.clone(); c.y = _gy(c.x, c.z);
  runeDecal(c, radius, 0x9a6bff, dur, 4, 0); let ang = 0;
  addEmitter({ pos: c.clone(), dur, rate: 0.03, tick: (e) => {
    ang += 0.5; for (const en of _enemiesIn(e.pos, radius)) { en.obj.position.x += (e.pos.x - en.obj.position.x) * 0.06; en.obj.position.z += (e.pos.z - en.obj.position.z) * 0.06; }
    spawnTrailPuff(new THREE.Vector3(e.pos.x + Math.cos(ang) * radius, _gy(e.pos.x, e.pos.z) + 0.6, e.pos.z + Math.sin(ang) * radius), 0x9a6bff, 0.7, 0.4, TEX.glow);
  } });
  if (dmg) setTimeout(() => { if (world) { for (const en of _enemiesIn(c, radius)) world.applyDamage(en, dmg, true); spawnExplosion(c.clone().setY(c.y + 0.5), radius * 0.8); } }, dur * 1000);
}
// 넉백: 적을 바깥으로 밀치며 피해
function knockback(radius, strength, dmg) {
  const c = player.position.clone();
  for (const e of _enemiesIn(c, radius)) { const d = e.obj.position.clone().sub(c); d.y = 0; if (d.lengthSq() < 0.01) d.set(1, 0, 0); d.normalize().multiplyScalar(strength); e.obj.position.x += d.x; e.obj.position.z += d.z; world.applyDamage(e, dmg, false); }
  fxRing(c, radius, 0xffe08a); spriteFlash(c.clone().setY(c.y + 1), TEX.glow, 0xffffff, 1, radius * 1.5, 0.3); spawnSparks(c, 0xffe08a, 16, 12); addShake(0.7);
}
// 돌진 강타: 시선/이동 방향으로 순간 전진하며 경로상 적 타격
function dashStrike(dist, dmg, radius) {
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz -= 1; if (keys.KeyS || keys.ArrowDown) iz += 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1; if (keys.KeyD || keys.ArrowRight) ix += 1;
  let dir; if (ix !== 0 || iz !== 0) { const ang = Math.atan2(ix, iz) + cam.yaw; dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)); } else dir = aimDir().clone();
  const start = player.position.clone(); player.rotation.y = Math.atan2(dir.x, dir.z); iframes = 0.35;
  const lim = WORLD * 0.46;
  const nx = THREE.MathUtils.clamp(start.x + dir.x * dist, -lim, lim), nz = THREE.MathUtils.clamp(start.z + dir.z * dist, -lim, lim);
  for (let s = 0; s <= 6; s++) { const p = start.clone().lerp(new THREE.Vector3(nx, 0, nz), s / 6); p.y = _gy(p.x, p.z); spawnTrailPuff(p.clone().setY(p.y + 1), 0xfff0a0, 1.0, 0.3); for (const e of _enemiesIn(p, radius)) if (!e._dashHit) { e._dashHit = 1; world.applyDamage(e, dmg, true); fxHit(e.obj.position, 0xffd23f); } }
  if (world) for (const e of world.enemies) e._dashHit = 0;
  player.position.set(nx, _gy(nx, nz), nz); camReady = false; addShake(0.6);
}
// 시한폭탄: 표식 후 delay초 뒤 대폭발
function bombDelayed(dmg, radius, delay) {
  const t = world && world.nearestEnemy(player.position, 40); const c = t ? t.obj.position.clone() : player.position.clone(); c.y = _gy(c.x, c.z);
  const warn = new THREE.Mesh(new THREE.RingGeometry(radius * 0.9, radius, 36), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.2, side: THREE.DoubleSide }));
  warn.rotation.x = -Math.PI / 2; warn.position.set(c.x, c.y + 0.1, c.z); scene.add(warn); warns.push({ mesh: warn, t: 0, dur: delay });
  spawnDecal(c, radius, 0xff5030, TEX.magic, delay, 2, 0);
  setTimeout(() => { if (!world) return; spawnExplosion(c.clone().setY(c.y + 0.5), radius); for (const e of _enemiesIn(c, radius)) world.applyDamage(e, dmg, true); }, delay * 1000);
}
// 처형: 광역 피해 + 저체력 적 즉결 처형(추가 피해)
function executeNearby(radius, dmg, threshFrac) {
  const c = player.position.clone();
  for (const e of _enemiesIn(c, radius)) {
    const lowHp = e.hp != null && e.maxHp ? (e.hp / e.maxHp) : 1;
    const final = lowHp <= (threshFrac || 0.3) ? dmg * 4 : dmg;
    world.applyDamage(e, final, lowHp <= (threshFrac || 0.3));
    if (lowHp <= (threshFrac || 0.3)) { spawnExplosion(e.obj.position.clone().setY(e.obj.position.y + 0.8), 2.2); }
  }
  spriteFlash(c.clone().setY(c.y + 1), TEX.glow, 0xff4040, 1, radius * 1.4, 0.35); screenFlash("rgba(255,60,60,0.3)", 0.3, 240); addShake(0.6);
}
// 전방 부채꼴 일격(원소 색)
function coneStrike(dmg, range, color, kind) {
  const dir = aimDir().clone(); const c = player.position.clone();
  for (let s = 1; s <= 5; s++) { const p = c.clone().addScaledVector(dir, range * s / 5); p.y = _gy(p.x, p.z) + 0.6; spriteFlash(p, TEX.glow, color, 0.6, 1.6 + s * 0.3, 0.3); }
  for (const e of world.enemies) { if (e.dead) continue; const to = e.obj.position.clone().sub(c); to.y = 0; const dist = to.length(); if (dist > range + 1.5) continue; to.normalize(); if (to.dot(dir) > 0.55) { world.applyDamage(e, dmg, false); if (kind === "fire") spawnEmbers(e.obj.position, color, 4, 1, 4); } }
  addShake(0.4);
}
// 자기 강화 버프(시간제한, 정확 복원)
const buffs = [];
function applyBuff(apply, revert, secs, color) {
  apply(); buffs.push({ revert, t: secs });
  if (color) auraFollow(secs, color, true);
  spriteFlash(player.position.clone().setY(player.position.y + 1), TEX.glow, color || 0xffffff, 0.8, 2.6, 0.4);
}
function updateBuffs(dt) { for (let i = buffs.length - 1; i >= 0; i--) { buffs[i].t -= dt; if (buffs[i].t <= 0) { buffs[i].revert(); buffs.splice(i, 1); } } }
// 다발 투사체(부채꼴 산탄)
function scatterShot(type, count, dmg, spread) {
  const dir = aimDir().clone(); const baseAng = Math.atan2(dir.x, dir.z);
  for (let i = 0; i < count; i++) { const a = baseAng + (i - (count - 1) / 2) * (spread || 0.18); spawnProjectile(type, new THREE.Vector3(Math.sin(a), 0.04, Math.cos(a)).normalize(), dmg, false); }
}
// 입력/시선 기준 수평 방향
function _inputDir() {
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz -= 1; if (keys.KeyS || keys.ArrowDown) iz += 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1; if (keys.KeyD || keys.ArrowRight) ix += 1;
  if (ix !== 0 || iz !== 0) { const ang = Math.atan2(ix, iz) + cam.yaw; return new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)); }
  return aimDir().clone();
}
// 궁수 갈고리 이동사격: 앵커(나무/천장/벽 방향 높은 지점)로 갈고리 걸어 비행하며 화살 난사
function grappleShot(dmg, dist) {
  const dir = _inputDir(); const lim = WORLD * 0.46;
  const ex = THREE.MathUtils.clamp(player.position.x + dir.x * (dist || 14), -lim, lim);
  const ez = THREE.MathUtils.clamp(player.position.z + dir.z * (dist || 14), -lim, lim);
  grappleFrom.copy(player.position); grappleTo.set(ex, 0, ez);
  grappleDur = 0.55; grappleT = grappleDur; iframes = 0.75; camReady = false;
  player.rotation.y = Math.atan2(dir.x, dir.z);
  const anchor = new THREE.Vector3(ex, terrainHeight(ex, ez) + (dungeon && dungeon.ceilingY ? Math.min(dungeon.ceilingY - 1, 9) : 9), ez);
  spriteFlash(anchor, TEX.glow, 0xffe08a, 0.6, 2.0, 0.3);   // 갈고리 박힘
  let acc = 0;
  addEmitter({ pos: anchor.clone(), dur: grappleDur + 0.15, rate: 0.07, tick: (e) => {
    spawnBolt(player.position.clone().setY(player.position.y + 1.3), e.pos, 0xffd98a);   // 로프
    const t = world && world.nearestEnemy(player.position, 42);
    const o = player.position.clone(); o.y += 1.3; let d;
    if (t) { const tp = t.obj.position.clone(); tp.y += 1; d = tp.sub(o).normalize(); }
    else { d = new THREE.Vector3(Math.sin(player.rotation.y), 0.05, Math.cos(player.rotation.y)).normalize(); }
    spawnProjectile("arrow", d, dmg, Math.random() < 0.3);
  } });
  addShake(0.35);
}
// 기사 검무: 주변 적을 차례로 베며 순간이동·회전(시점 함께 이동), 무적
function bladeDance(dmg, dur, radius) {
  iframes = dur + 0.15;
  addEmitter({ pos: player.position.clone(), dur, rate: 0.13, tick: () => {
    iframes = Math.max(iframes, 0.26);
    const lim = WORLD * 0.46, t = world && world.nearestEnemy(player.position, 20);
    if (t) {
      const dir = t.obj.position.clone().sub(player.position); dir.y = 0;
      if (dir.lengthSq() < 0.01) dir.set(0, 0, 1); dir.normalize();
      const step = THREE.MathUtils.clamp(player.position.distanceTo(t.obj.position) - 1.8, 0, 5);
      const nx = THREE.MathUtils.clamp(player.position.x + dir.x * step, -lim, lim), nz = THREE.MathUtils.clamp(player.position.z + dir.z * step, -lim, lim);
      player.position.set(nx, terrainHeight(nx, nz), nz); player.rotation.y = Math.atan2(dir.x, dir.z);
    } else {
      player.rotation.y += 1.4; const f = new THREE.Vector3(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
      const nx = THREE.MathUtils.clamp(player.position.x + f.x * 2.6, -lim, lim), nz = THREE.MathUtils.clamp(player.position.z + f.z * 2.6, -lim, lim);
      player.position.set(nx, terrainHeight(nx, nz), nz);
    }
    camReady = false;
    const c = player.position.clone().setY(player.position.y + 1);
    spriteFlash(c, TEX.ring, 0xfff0a0, 1, radius * 2.4, 0.22, null, 7); spawnSparks(c, 0xfff0a0, 8, 9);
    if (atkAdd) { atkAdd.stop(); atkAdd.reset(); atkAdd.setEffectiveWeight(1); atkAdd.timeScale = 1.6; atkAdd.play(); }
    for (const en of _enemiesIn(player.position, radius)) world.applyDamage(en, dmg, Math.random() < 0.4);
  } });
  screenFlash("rgba(255,240,160,0.2)", 0.2, 220); addShake(0.4);
}
// 대지 강타: 균열 링 + 파편이 위로 튐 + 강한 흔들림
function groundSmash(radius, dmg) {
  const pos = player.position.clone();
  fxRing(pos, radius, 0xffcc66); fxRing(pos, radius * 0.6, 0xffaa33);
  for (let k = 0; k < 24; k++) spawnBurst(new THREE.Vector3(pos.x + (Math.random() - 0.5) * radius, terrainHeight(pos.x, pos.z) + 0.3, pos.z + (Math.random() - 0.5) * radius), 0x9a6b40, 1, 10, 0.3, 0.75);
  addShake(1.2);
  if (world) { for (const e of world.enemies.slice()) if (!e.dead && e.obj.position.distanceTo(pos) < radius + e.def.radius) world.applyDamage(e, dmg, false); if (world.stunNearby) world.stunNearby(pos, radius, 1.2); }
}
// 보스 텔레그래프 지역기: 경고 링이 점점 진해진 뒤 폭발(밖으로 나가야 함)
function bossAoE(pos, radius, dmg, delay) {
  const warn = new THREE.Mesh(new THREE.RingGeometry(radius * 0.92, radius, 40), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.15, side: THREE.DoubleSide }));
  warn.rotation.x = -Math.PI / 2; warn.position.set(pos.x, terrainHeight(pos.x, pos.z) + 0.1, pos.z); scene.add(warn);
  warns.push({ mesh: warn, t: 0, dur: delay });
  setTimeout(() => {
    const p2 = new THREE.Vector3(pos.x, terrainHeight(pos.x, pos.z) + 0.5, pos.z);
    spawnExplosion(p2, radius);
    if (player && !GAME.dead && player.position.distanceTo(pos) < radius) onPlayerHit(dmg);
  }, delay * 1000);
}
function updateWarns(dt) {
  for (let i = warns.length - 1; i >= 0; i--) { const w = warns[i]; w.t += dt; w.mesh.material.opacity = 0.15 + 0.65 * Math.min(1, w.t / w.dur); if (w.t >= w.dur) { scene.remove(w.mesh); warns.splice(i, 1); } }
}

// 보스 슬램/소환·폭발 등 바닥 충격 링 + 파티클 + 흔들림
function fxRing(pos, radius, color) {
  const g = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 28), new THREE.MeshBasicMaterial({ color: color || 0xffaa33, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  g.rotation.x = -Math.PI / 2; g.position.set(pos.x, terrainHeight(pos.x, pos.z) + 0.12, pos.z);
  scene.add(g); fx.push({ mesh: g, t: 0, dur: 0.5, r: radius });
  spawnBurst(new THREE.Vector3(pos.x, terrainHeight(pos.x, pos.z) + 0.5, pos.z), color || 0xffaa33, 14, 9, 0.2, 0.55);
  addShake(0.5);
}
function spawnExplosion(pos, r) {
  animExplosion(pos, r * 3.2, 0xffffff, 0.55);                                  // 실제 화염 폭발 애니메이션(다운로드 에셋)
  spriteFlash(pos, TEX.glow, 0xffffff, r * 0.5, r * 1.6, 0.16);                 // 흰열 폭심(순간)
  spriteFlash(pos, TEX.ring, 0xffb347, r * 0.5, r * 3.2, 0.55, null, 2.2);      // 충격파 링
  runeDecal(pos, r * 1.1, 0xff8a3a, 0.6, 3, 0.6);                  // 바닥 마법진/폭심 자국
  for (let k = 0; k < 3; k++) {
    const sp = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * r, Math.random() * 0.6 * r, (Math.random() - 0.5) * r));
    spriteFlash(sp, TEX.smoke, 0x4a3528, r * 0.6, r * 1.8, 0.8, "normal");       // 검은 연기 잔류(노멀 블렌딩)
  }
  spawnSparks(pos, 0xffd27a, 20, 13); spawnEmbers(pos, 0xff9a3a, 12, r * 0.6, 5);
  if (r >= 5) screenFlash("rgba(255,180,90,0.5)", 0.5, 260);                    // 대형 폭발만 화면 섬광
  addShake(0.7); addHitstop(0.06);
}
// 타격 스파크(적이 맞을 때)
function fxHit(pos, color) {
  const p = new THREE.Vector3(pos.x, pos.y + 1.0, pos.z);
  spriteFlash(p, TEX.glow, color || 0xfff1a8, 0.35, color === 0xffd23f ? 1.9 : 1.3, 0.2);
  spawnSparks(p, color || 0xffe08a, color === 0xffd23f ? 10 : 6, 9);
  addShake(0.22);
  if (color === 0xffd23f) addHitstop(0.05);   // 크리티컬 시 순간 정지
}
// 투사체가 솔리드 장애물(바위/나무)에 막혔는지 — 엄폐물 뒤로 숨으면 피탄되지 않게
function _projBlocked(p) {
  const py = p.mesh.position.y;
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k];
    if (py > o.h) continue;                          // 장애물보다 높이 나는 투사체는 통과
    const dx = p.mesh.position.x - o.x, dz = p.mesh.position.z - o.z;
    const rr = o.r + p.hitR * 0.5;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}
// 투사체 제거 — 그룹의 스프라이트 머티리얼만 정리(코어 지오메트리/머티리얼은 공유라 보존)
function removeProjectile(p, i) {
  p.mesh.traverse((o) => { if (o.isSprite && o.material) o.material.dispose(); });
  scene.remove(p.mesh); projectiles.splice(i, 1);
}
function updateProjectiles(dt) {
  const enemies = world ? world.enemies : [];
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.mesh.position.addScaledVector(p.vel, dt); p.life -= dt;
    if (p.trail) { p._tacc += dt; if (p._tacc >= p.trail.rate) { p._tacc = 0; spawnTrailPuff(p.mesh.position, p.trail.color, p.trail.size, p.trail.life, p.trail.tex); } }
    const onGround = p.mesh.position.y <= terrainHeight(p.mesh.position.x, p.mesh.position.z);
    const blocked = _projBlocked(p);                 // 엄폐물에 차폐

    if (p.owner === "enemy") {                       // 적 투사체 → 플레이어
      let hit = player && !GAME.dead && p.mesh.position.distanceTo(player.position) < p.hitR + 1.0;
      if (hit || onGround || blocked || p.life <= 0) {
        if (hit) onPlayerHit(Math.round(p.dmg));
        removeProjectile(p, i);
      }
      continue;
    }

    // 플레이어 투사체 → 적
    if (p.type === "fireball") {
      let hit = false;
      const fuse = Math.max(p.hitR, p.aoe * 0.45);    // 근접 신관: 적 근처면 확실히 폭발(다중 화염구 전부 명중)
      for (const e of enemies) { if (!e.dead && p.mesh.position.distanceTo(e.obj.position) < fuse + e.def.radius) { hit = true; break; } }
      if (hit || onGround || blocked || p.life <= 0) {
        for (const e of enemies.slice()) {
          if (!e.dead && p.mesh.position.distanceTo(e.obj.position) < p.aoe + e.def.radius) {
            world.applyDamage(e, p.dmg, p.crit);
            if (world.applyStatus) world.applyStatus(e, "fire", { dur: 2.5, dps: Math.max(4, Math.round(p.dmg * 0.15)) });   // 화염구: 화상 부여
          }
        }
        spawnExplosion(p.mesh.position, p.aoe);
        removeProjectile(p, i);
      }
    } else {                                          // 화살/볼트 — 관통(pierce) 지원
      for (const e of enemies) {
        if (e.dead || p.hitSet.has(e)) continue;
        if (p.mesh.position.distanceTo(e.obj.position) < p.hitR + e.def.radius) {
          world.applyDamage(e, p.dmg, p.crit); p.hitSet.add(e);
          if (p.pierce > 0) p.pierce--; else { removeProjectile(p, i); break; }
        }
      }
      if (projectiles[i] === p && (onGround || blocked || p.life <= 0)) { removeProjectile(p, i); }
    }
  }
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.t += dt;
    const k = f.t / f.dur;
    f.mesh.scale.setScalar(0.4 + k * f.r);
    f.mesh.material.opacity = Math.max(0, 0.85 * (1 - k));
    if (f.t >= f.dur) { scene.remove(f.mesh); fx.splice(i, 1); }
  }
}

const _proj = new THREE.Vector3();
function onDamageNumber(worldPos, yOff, amount, type) {
  _proj.copy(worldPos); _proj.y += yOff; _proj.project(camera);
  if (_proj.z > 1) return;                     // 카메라 뒤면 표시 안 함
  UI.floatDamage((_proj.x * 0.5 + 0.5) * innerWidth, (-_proj.y * 0.5 + 0.5) * innerHeight, amount, type);
}

// 흡혈: 가한 피해의 일부를 회복(스킬)
// 무적 빌드 방지 — ①흡혈률 상한 ②짧은 시간창 회복 총량 상한(다중 투사체·광역 폭발 누적 차단)
let lsBudget = 0;                 // 현재 시간창에서 이미 회복한 양
function onHit(dmg) {
  if (GAME.dead || !PSTATS.lifesteal) return;
  const rate = Math.min(PSTATS.lifesteal, 0.35);     // 흡혈률 최대 35%
  const cap = GAME.maxHp * 0.12;                     // 0.6초당 최대 회복 = 최대 체력의 12%
  if (lsBudget >= cap) return;
  let heal = Math.min(dmg * rate, cap - lsBudget);
  if (heal <= 0) return;
  lsBudget += heal;
  GAME.hp = Math.min(GAME.maxHp, GAME.hp + heal);
  UI.setHP(GAME.hp, GAME.maxHp);
}

// ---------- 레벨업 스킬 드래프트(카드 1택) ----------
const ALLCLS = ["knight", "mage", "archer"];
const KNIGHT = ["knight"], MAGE = ["mage"], ARCHER = ["archer"];
const healHp = (n) => { GAME.maxHp += n; GAME.hp = Math.min(GAME.maxHp, GAME.hp + n); UI.setHP(GAME.hp, GAME.maxHp); };
// 스탯 적용기(클로저) — 모듈 스코프 변수(WALK/RUN/PSTATS/GAME) 직접 조작
const FX = {
  dmg: (v) => () => { PSTATS.dmg += v; },
  spd: (v) => () => { PSTATS.atkInterval *= v; },         // v<1 = 공속↑
  crit: (v) => () => { PSTATS.critChance += v; },
  cdmg: (v) => () => { PSTATS.critMult += v; },
  ls: (v) => () => { PSTATS.lifesteal += v; },
  hp: (v) => () => { healHp(v); },
  dr: (v) => () => { PSTATS.dmgReduce = Math.min(0.75, PSTATS.dmgReduce + v); },
  cd: (v) => () => { PSTATS.skillCdMult *= v; },
  mv: (v) => () => { WALK *= v; RUN *= v; },
  reach: (v) => () => { PSTATS.meleeReach += v; },
  aoe: (v) => () => { PSTATS.aoe += v; },
  shots: (v) => () => { PSTATS.extraShots += v; },
  proj: (v) => () => { PSTATS.projSpeed += v; },
  pierce: (v) => () => { PSTATS.pierce += v; },
  combo: (fns) => () => { fns.forEach((f) => f()); },
};
let _sid = 0;
// 직업 스킬 생성: [statKey, [[이름,설명,값], ...]] 묶음을 평탄화
function genSkills(cls, groups) {
  const out = [];
  for (const [stat, rows] of groups) for (const [n, d, v] of rows)
    out.push({ id: "s" + _sid++, name: n, desc: d, cls, apply: FX[stat](v) });
  return out;
}
const SKILLS = [
  // ───── 공용 3종 ─────
  { id: "power", name: "화력 강화", desc: "공격 피해 +4", cls: ALLCLS, apply: FX.dmg(4) },
  { id: "haste", name: "연사", desc: "공격속도 +15%", cls: ALLCLS, apply: FX.spd(0.85) },
  { id: "vigor", name: "강철 체력", desc: "최대 체력 +30, 회복", cls: ALLCLS, apply: FX.hp(30) },

  // ───── 기사 전용 30종 ─────
  ...genSkills(KNIGHT, [
    ["dmg", [["분노의 일격", "공격 피해 +4", 4], ["강철 일격", "공격 피해 +7", 7], ["파괴의 일격", "공격 피해 +11", 11], ["용살자의 검", "공격 피해 +16", 16]]],
    ["spd", [["쾌속 검술", "공격속도 +12%", 0.88], ["연속 베기", "공격속도 +18%", 0.82], ["광란의 검무", "공격속도 +26%", 0.74]]],
    ["reach", [["넓은 베기", "근접 사거리 +0.7", 0.7], ["회전 베기", "근접 사거리 +1.1", 1.1], ["대선풍", "근접 사거리 +1.6", 1.6], ["대지 가르기", "근접 사거리 +2.2", 2.2]]],
    ["dr", [["수호 의지", "받는 피해 -10%", 0.10], ["철벽", "받는 피해 -16%", 0.16], ["불괴의 의지", "받는 피해 -22%", 0.22]]],
    ["hp", [["강건", "최대 체력 +35, 회복", 35], ["불굴", "최대 체력 +55, 회복", 55], ["거인의 체력", "최대 체력 +85, 회복", 85]]],
    ["crit", [["치명 강타", "치명타 확률 +12%", 0.12], ["약점 간파", "치명타 확률 +18%", 0.18]]],
    ["cdmg", [["처형", "치명타 피해 +55%", 0.55], ["참수", "치명타 피해 +90%", 0.90]]],
    ["ls", [["흡혈 검기", "피해의 10% 회복", 0.10], ["피의 갈망", "피해의 16% 회복", 0.16]]],
    ["cd", [["투기 숙련", "클래스 스킬 쿨다운 -18%", 0.82], ["전투 본능", "클래스 스킬 쿨다운 -28%", 0.72]]],
    ["mv", [["기동 보행", "이동 속도 +10%", 1.10], ["돌격 보행", "이동 속도 +16%", 1.16]]],
    ["combo", [
      ["광전사", "공격 피해 +5, 공격속도 +10%", [FX.dmg(5), FX.spd(0.90)]],
      ["수문장", "최대 체력 +30, 받는 피해 -8%", [FX.hp(30), FX.dr(0.08)]],
      ["성기사", "최대 체력 +40, 피해의 8% 회복", [FX.hp(40), FX.ls(0.08)]],
      ["검성", "공격 피해 +6, 치명타 확률 +10%", [FX.dmg(6), FX.crit(0.10)]],
    ]],
  ]),

  // ───── 마법사 전용 30종 ─────
  ...genSkills(MAGE, [
    ["aoe", [["폭발 확장", "파이어볼 범위 +1.0", 1.0], ["대폭발", "파이어볼 범위 +1.6", 1.6], ["초신성", "파이어볼 범위 +2.4", 2.4]]],
    ["shots", [["다중 시전", "투사체 +1", 1], ["삼중 시전", "투사체 +2", 2]]],
    ["dmg", [["주문 위력", "공격 피해 +5", 5], ["고위 주문", "공격 피해 +8", 8], ["금단의 주문", "공격 피해 +13", 13], ["파멸의 주문", "공격 피해 +18", 18]]],
    ["proj", [["신속 시전", "투사체 속도 +10", 10], ["가속 시전", "투사체 속도 +16", 16], ["섬광 시전", "투사체 속도 +24", 24]]],
    ["spd", [["영창 가속", "공격속도 +12%", 0.88], ["신속 영창", "공격속도 +18%", 0.82], ["연속 영창", "공격속도 +26%", 0.74]]],
    ["crit", [["주문 폭격", "치명타 확률 +12%", 0.12], ["마력 집중", "치명타 확률 +18%", 0.18]]],
    ["cdmg", [["마력 폭주", "치명타 피해 +55%", 0.55], ["파동 폭주", "치명타 피해 +90%", 0.90]]],
    ["cd", [["마나 흐름", "클래스 스킬 쿨다운 -18%", 0.82], ["마나 순환", "클래스 스킬 쿨다운 -28%", 0.72]]],
    ["ls", [["생명 흡수", "피해의 10% 회복", 0.10], ["영혼 흡수", "피해의 16% 회복", 0.16]]],
    ["hp", [["비전 보호막", "최대 체력 +30, 회복", 30], ["대마법 보호막", "최대 체력 +50, 회복", 50]]],
    ["mv", [["순보", "이동 속도 +10%", 1.10], ["섬보", "이동 속도 +16%", 1.16]]],
    ["combo", [
      ["원소술사", "투사체 +1, 파이어볼 범위 +0.8", [FX.shots(1), FX.aoe(0.8)]],
      ["대마법사", "공격 피해 +6, 치명타 확률 +10%", [FX.dmg(6), FX.crit(0.10)]],
      ["비전학자", "최대 체력 +25, 쿨다운 -15%", [FX.hp(25), FX.cd(0.85)]],
      ["흑마법사", "공격 피해 +5, 피해의 8% 회복", [FX.dmg(5), FX.ls(0.08)]],
    ]],
  ]),

  // ───── 궁수 전용 30종 ─────
  ...genSkills(ARCHER, [
    ["pierce", [["관통", "적 1명 더 관통", 1], ["꿰뚫기", "적 2명 더 관통", 2]]],
    ["shots", [["다중 사격", "투사체 +1", 1], ["연발 사격", "투사체 +2", 2]]],
    ["spd", [["속사", "공격속도 +14%", 0.86], ["쾌속 사격", "공격속도 +20%", 0.80], ["폭풍 사격", "공격속도 +28%", 0.72]]],
    ["dmg", [["강궁", "공격 피해 +4", 4], ["강철 화살", "공격 피해 +7", 7], ["관통 화살촉", "공격 피해 +11", 11], ["용아 화살", "공격 피해 +16", 16]]],
    ["crit", [["정밀 사격", "치명타 확률 +14%", 0.14], ["매의 눈", "치명타 확률 +20%", 0.20]]],
    ["cdmg", [["급소 사격", "치명타 피해 +60%", 0.60], ["치명 사격", "치명타 피해 +95%", 0.95]]],
    ["proj", [["초고속 화살", "투사체 속도 +12", 12], ["음속 화살", "투사체 속도 +20", 20], ["광속 화살", "투사체 속도 +30", 30]]],
    ["mv", [["질주", "이동 속도 +12%", 1.12], ["바람의 발", "이동 속도 +18%", 1.18], ["그림자 보행", "이동 속도 +24%", 1.24]]],
    ["ls", [["흡취", "피해의 10% 회복", 0.10], ["생명 사냥", "피해의 16% 회복", 0.16]]],
    ["cd", [["사냥꾼 본능", "클래스 스킬 쿨다운 -18%", 0.82], ["야생의 직감", "클래스 스킬 쿨다운 -28%", 0.72]]],
    ["hp", [["강인함", "최대 체력 +30, 회복", 30], ["맹수의 체력", "최대 체력 +50, 회복", 50]]],
    ["combo", [
      ["저격수", "공격 피해 +5, 치명타 확률 +10%", [FX.dmg(5), FX.crit(0.10)]],
      ["연사수", "투사체 +1, 공격속도 +8%", [FX.shots(1), FX.spd(0.92)]],
      ["추적자", "이동 속도 +10%, 피해의 8% 회복", [FX.mv(1.10), FX.ls(0.08)]],
    ]],
  ]),
];
let skillLv = {};   // 스킬 보유 레벨(중복 선택 시 누적 → 같은 스킬을 레벨업처럼 강화)
function _draftDone() {
  pendingLv--;
  if (pendingLv > 0) openDraft(); else { paused = false; UI.setXP(GAME.xp, GAME.xpNext, GAME.level); }
}
function openDraft() {
  if (pendingLv <= 0) { paused = false; return; }
  paused = true;
  const mine = SKILLS.filter((s) => !s.cls || s.cls.includes(PSTATS.cls));
  const uniq = mine.filter((s) => s.cls && s.cls.length < ALLCLS.length);   // 직업 전용
  const rest = mine.filter((s) => !uniq.includes(s));
  const pick = (arr) => arr.splice(Math.floor(Math.random() * arr.length), 1)[0];
  const up = uniq.slice(), rp = rest.slice(), ch = [];
  const nU = Math.min(up.length, 1 + (Math.random() < 0.5 ? 1 : 0));        // 전용 1~2장 보장
  for (let i = 0; i < nU; i++) ch.push(pick(up));
  while (ch.length < 3 && rp.length) ch.push(pick(rp));
  while (ch.length < 3 && up.length) ch.push(pick(up));
  for (let i = ch.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ch[i], ch[j]] = [ch[j], ch[i]]; }
  const cards = ch.map((s) => {
    const lv = skillLv[s.id] || 0;
    return { name: s.name + (lv > 0 ? "  Lv" + (lv + 1) : ""), desc: s.desc + (lv > 0 ? "  · 보유 Lv" + lv + " → Lv" + (lv + 1) : "") };
  });
  UI.showLevelUp(cards, (idx) => {
    const s = ch[idx];
    if (s && s.apply) { s.apply(); skillLv[s.id] = (skillLv[s.id] || 0) + 1; UI.toast("습득: " + s.name + (skillLv[s.id] > 1 ? " Lv" + skillLv[s.id] : "")); }
    _draftDone();
  }, () => {                                  // 건너뛰기: 작은 보상(회복 + 소량 영구 강화)
    healHp(20); PSTATS.dmg += 2;
    UI.toast("선택 건너뜀 — 체력 +20, 공격 +2");
    _draftDone();
  });
}
function addXP(n) {
  GAME.xp += n;
  let leveled = 0;
  while (GAME.xp >= GAME.xpNext) {
    GAME.xp -= GAME.xpNext; GAME.level++; GAME.xpNext = GAME.level * 90;
    GAME.maxHp += 10; GAME.hp = GAME.maxHp; leveled++;
  }
  if (leveled) { UI.setHP(GAME.hp, GAME.maxHp); UI.banner("LEVEL UP!  Lv " + GAME.level, 1200); pendingLv += leveled; if (!paused) openDraft(); }
  UI.setXP(GAME.xp, GAME.xpNext, GAME.level);
}
function onEnemyKilled(type, xp) { addXP(xp); GAME.gold += Math.round(xp / 4); UI.setGold(GAME.gold); }

function onPlayerHit(dmg) {
  if (GAME.dead) return;
  if (parryWindow > 0) {                            // 패링 성공! 피해 무효 + 주변 적 기절
    parryWindow = 0; iframes = 0.3;
    if (world && world.stunNearby) world.stunNearby(player.position, 6.5, 2.5);
    UI.banner("패링!  적 기절", 900);
    return;
  }
  if (iframes > 0) return;                          // 구르기/블링크 무적
  if (playerShield > 0) return;   // 수호 방패: 피해 무효
  if (PSTATS.dmgReduce) dmg = Math.max(1, Math.round(dmg * (1 - PSTATS.dmgReduce)));   // 수호 의지(기사)
  GAME.hp = Math.max(0, GAME.hp - dmg);
  UI.setHP(GAME.hp, GAME.maxHp);
  onDamageNumber(player.position, 2.0, dmg, "enemy");
  if (GAME.hp <= 0) die();
}
function die() {
  GAME.dead = true;
  if (atkAdd) atkAdd.stop();
  playOnce(CLIP.death, () => {});                 // then 콜백이 truthy라 완료 후 Idle로 안 돌아가고 Death 유지
  UI.banner("사망… 잠시 후 부활", 2200);
  setTimeout(respawn, 2400);
}
function respawn() {
  GAME.hp = GAME.maxHp; GAME.dead = false; oneShot = null; vy = 0; grounded = true;
  player.position.set(0, terrainHeight(0, 0), 0);
  UI.setHP(GAME.hp, GAME.maxHp); fade(CLIP.idle, 0.2);
}

// ---------- 바이옴(층 테마) ----------
// 층을 깰 때마다 지형 텍스처·식생·하늘·조명·안개가 통째로 바뀐다.
const BIOMES = {
  forest: { name: "숲", tex: "grass", tint: 0x9fbf7a, sky: true, elev: 55,
    fog: 0xcfe0ee, near: 120, far: 300, hemiSky: 0xbfe3ff, hemiGr: 0x6b7a4a, hemiI: 0.9, sunC: 0xfff4e0, sunI: 2.6,
    water: true, waterC: 0x2f6f9e, plight: false,
    props: [{ kind: "leafy", n: 120, minH: WATER_Y + 0.8, maxH: 10, sMin: 0.8, sMax: 1.5, solid: true, cr: 0.55, ch: 8 },
            { kind: "bushes", n: 70, maxH: 9 }, { kind: "grass", n: 150, maxH: 8, cast: false }, { kind: "rocks", n: 50, solid: true, cr: 1.1, ch: 3 }] },
  cave: { name: "동굴", tex: "rock", tint: 0xb4b4be, sky: false, bg: 0x1a1d27,
    fog: 0x1a1d27, near: 16, far: 95, hemiSky: 0x6d7aa0, hemiGr: 0x24283a, hemiI: 0.7, sunC: 0x9fb4d8, sunI: 0.5, ambient: 0.55,
    water: false, plight: true, plightC: 0xffe0b0, plightI: 30, plightDist: 38,
    props: [{ kind: "rocks", n: 150, sMin: 0.7, sMax: 2.3, solid: true, cr: 1.0, ch: 3 },
            { kind: "rocks", n: 45, emissive: 0x33e6ff, sMin: 0.4, sMax: 1.0, cast: false }] },
  snow: { name: "설원", tex: "snow", tint: 0xeef4ff, sky: true, elev: 28,
    fog: 0xdfe8f2, near: 80, far: 250, hemiSky: 0xdfeaff, hemiGr: 0x9fb0c8, hemiI: 1.0, sunC: 0xfff6e8, sunI: 2.2,
    water: false, plight: false,
    props: [{ kind: "pine", n: 90, maxH: 11, sMin: 0.8, sMax: 1.5, solid: true, cr: 0.55, ch: 9 }, { kind: "rocks", n: 70, solid: true, cr: 1.0, ch: 3 }] },
  lava: { name: "용암 동굴", tex: "rock", tint: 0x7a4034, sky: false, bg: 0x2a1208,
    fog: 0x3a1810, near: 26, far: 140, hemiSky: 0xaa5540, hemiGr: 0x2a0e08, hemiI: 0.75, sunC: 0xff8a4a, sunI: 1.7, ambient: 0.4,
    water: true, waterC: 0xff4500, plight: true, plightC: 0xff8050, plightI: 22, plightDist: 36,
    props: [{ kind: "rocks", n: 120, sMin: 0.7, sMax: 2.0, solid: true, cr: 1.0, ch: 3 },
            { kind: "rocks", n: 35, emissive: 0xff5520, sMin: 0.4, sMax: 1.1, cast: false }] },
};
const BIOME_ORDER = ["forest", "cave", "snow", "lava"];
// 20층 테마 — 4종 베이스(숲/동굴/설원/용암)를 색조·안개·조명으로 변주해 층마다 다른 분위기.
function _theme(base, over) { return Object.assign({}, BIOMES[base], over); }
const FLOOR_THEMES = [
  _theme("forest", { name: "숲" }),
  _theme("forest", { name: "깊은 숲", tint: 0x6f9a5a, fog: 0xb6ccb4, far: 240, hemiGr: 0x4a5a32 }),
  _theme("cave",   { name: "수정 동굴", tint: 0x8ba6cc, bg: 0x141a2a, plightC: 0x66c0ff }),
  _theme("snow",   { name: "설원" }),
  _theme("snow",   { name: "빙하 협곡", tint: 0xcfe2ff, fog: 0xcdd9ee, sunC: 0xeaf2ff }),
  _theme("lava",   { name: "화염 동굴" }),
  _theme("lava",   { name: "용암 지대", tint: 0x9a4030, waterC: 0xff5a14, plightC: 0xff9a50 }),
  _theme("forest", { name: "독성 늪", tint: 0x7fae4a, fog: 0xaec27a, waterC: 0x4f7a2e, hemiSky: 0xcfe39a }),
  _theme("snow",   { name: "황무지", tint: 0xb09a72, fog: 0xd8caa8, sunC: 0xfff0d0, hemiSky: 0xe8dcc0 }),
  _theme("cave",   { name: "고대 폐허", tint: 0xcaa860, bg: 0x221c12, plightC: 0xffd27a }),
  _theme("cave",   { name: "어둠의 동굴", tint: 0x5a5a72, bg: 0x0e0f17, plightC: 0x9a8aff, far: 80 }),
  _theme("snow",   { name: "서리 심연", tint: 0xaecfe8, fog: 0xc2d4ea, sunC: 0xdce8ff }),
  _theme("lava",   { name: "잿빛 화산", tint: 0x8a5a4a, fog: 0x4a2a20, plightC: 0xff7a40 }),
  _theme("forest", { name: "부패의 늪", tint: 0x6f9a3a, fog: 0x9ab06a, waterC: 0x3f6a24, hemiSky: 0xbcd488 }),
  _theme("forest", { name: "황혼 평원", tint: 0xb08ad0, fog: 0xd4bce8, sunC: 0xffd8e8, hemiSky: 0xe0c8f0 }),
  _theme("cave",   { name: "결정 심연", tint: 0x66c0c0, bg: 0x0e2024, plightC: 0x66f0e0 }),
  _theme("lava",   { name: "지옥불", tint: 0xc24020, fog: 0x4a1408, waterC: 0xff4500, plightC: 0xff8040, plightI: 26 }),
  _theme("snow",   { name: "영원한 겨울", tint: 0xe2eeff, fog: 0xdce8f6, sunC: 0xf0f6ff }),
  _theme("cave",   { name: "공허의 균열", tint: 0x7a5aa0, bg: 0x120a1e, plightC: 0xb070ff, far: 85 }),
  _theme("lava",   { name: "마왕의 옥좌", tint: 0x8a2018, bg: 0x2a0808, fog: 0x3a0c08, waterC: 0xff3010, plightC: 0xff5030, plightI: 28 }),
];
function biomeFor(floor) { return FLOOR_THEMES[(floor - 1) % FLOOR_THEMES.length]; }

function applyBiome(b) {
  terrainMesh.material = biomeMat(b);
  waterMesh.visible = !!b.water;
  if (b.water && b.waterC != null) waterMesh.material.color.setHex(b.waterC);
  sky.visible = !!b.sky;
  scene.background = b.sky ? null : new THREE.Color(b.bg || 0x000000);
  if (b.sky) {
    const phi = THREE.MathUtils.degToRad(90 - b.elev), theta = THREE.MathUtils.degToRad(135);
    sunPos.setFromSphericalCoords(1, phi, theta); skyU.sunPosition.value.copy(sunPos);
    sun.position.copy(sunPos).multiplyScalar(150);
  } else { sun.position.set(40, 90, 25); }
  scene.fog.color.setHex(b.fog); scene.fog.near = b.near; scene.fog.far = b.far;
  hemi.color.setHex(b.hemiSky); hemi.groundColor.setHex(b.hemiGr); hemi.intensity = b.hemiI;
  sun.color.setHex(b.sunC); sun.intensity = b.sunI;
  ambient.intensity = b.ambient || 0;
  // 블룸: 밝은 하늘 바이옴은 약하게(하늘 번짐 방지), 어두운 폐쇄 바이옴은 강하게(발광 강조)
  bloomPass.strength = b.sky ? 0.12 : 0.65;
  bloomPass.threshold = b.sky ? 0.92 : 0.7;
  if (playerLight) {   // visible 토글 대신 intensity로 제어 → 조명 개수 불변(셰이더 재컴파일 방지)
    if (b.plight) { playerLight.color.setHex(b.plightC); playerLight.intensity = b.plightI; playerLight.distance = b.plightDist || 30; }
    else playerLight.intensity = 0;
  }
}
function scatterBiome(b) {
  for (let i = propGroup.children.length - 1; i >= 0; i--) propGroup.remove(propGroup.children[i]);
  obstacles.length = 0;   // 이전 층 장애물 콜라이더 정리
  if (!NP) return;
  for (const p of b.props) { const protos = NP[p.kind]; if (protos) scatterFrom(protos, p.n, p); }
}
function enterFloor(floor) {
  paused = false;                  // 보스 보상/클리어 모달 해제
  GAME.floor = floor;
  const b = biomeFor(floor);
  applyBiome(b);
  scatterBiome(b);
  // 폐쇄형(동굴/용암)은 벽·천장으로 가두고, 개방형은 벽 없음
  const enclosed = !b.sky;
  const arena = enclosed ? 56 : 70;
  dungeon.rebuild({ enclosed, ceiling: enclosed, arena, wallTint: b.tint });
  // 이전 층의 투사체·연출 정리 + 발사 슬롯 초기화
  for (const p of projectiles) scene.remove(p.mesh); projectiles.length = 0;
  for (const f of fx) scene.remove(f.mesh); fx.length = 0;
  playerAtkCd = 0;
  player.position.set(0, terrainHeight(0, 0), 0);
  vy = 0; grounded = true; camReady = false;       // 카메라 재정착
  world.startFloor(floor, { arena });
  UI.setFloor(floor, b.name);
  UI.banner(floor + "층 · " + b.name, 1700);
}
// ---------- 액티브 스킬 (보스 보상, Q/W/E/R 장착, 티어) ----------
// 속성별 상태이상 부여(원소 차별화): 불=화상, 독=중독, 얼음=둔화, 번개=감전
function _applyElem(e, kind, dmg) {
  if (!world || !world.applyStatus) return;
  if (kind === "fire") world.applyStatus(e, "fire", { dur: 3, dps: Math.max(5, Math.round((dmg || 0) * 0.15)) });
  else if (kind === "poison") world.applyStatus(e, "poison", { dur: 4, dps: Math.max(4, Math.round((dmg || 0) * 0.12)) });
  else if (kind === "ice" || kind === "frost") world.applyStatus(e, "ice", { dur: 2.5 });
  else if (kind === "lightning" || kind === "shock") world.applyStatus(e, "lightning", { dur: 2.5 });
}
const SKILL_API = {
  fxRing, spawnExplosion, addShake,
  heal(p) { GAME.hp = Math.min(GAME.maxHp, GAME.hp + GAME.maxHp * p); UI.setHP(GAME.hp, GAME.maxHp); const c = player.position.clone().setY(player.position.y + 1); spriteFlash(c, TEX.glow, 0x7dffa0, 0.6, 2.4, 0.5); spawnSparks(c, 0x9bffb8, 14, 6); auraFollow(0.8, 0x66ff88, true); },
  aoe(radius, dmg, color, kind) { if (!world) return; elementBurst(player.position.clone().setY(player.position.y + 0.6), radius, color || 0xff8a3a, kind); for (const e of world.enemies.slice()) if (!e.dead && e.obj.position.distanceTo(player.position) < radius + e.def.radius) { world.applyDamage(e, dmg, false); _applyElem(e, kind, dmg); } },
  frost(radius, dur, big) { if (world && world.stunNearby) world.stunNearby(player.position, radius, dur); if (world && world.applyStatus) for (const e of world.enemies) if (!e.dead && e.obj.position.distanceTo(player.position) < radius + e.def.radius) world.applyStatus(e, "ice", { dur: Math.max(2.5, dur + 1.5) }); const c = player.position.clone().setY(player.position.y + 0.6); if (big) blizzard(c, radius, dur + 0.5); else frostNova(c, Math.min(radius, 9), 1.0); },
  stun(radius, dur) { if (world && world.stunNearby) { world.stunNearby(player.position, radius, dur); fxRing(player.position, Math.min(radius, 12), 0x66ccff); } },
  chain(n, dmg) { if (!world) return; world.enemies.filter((e) => !e.dead).sort((a, b) => a.obj.position.distanceTo(player.position) - b.obj.position.distanceTo(player.position)).slice(0, n).forEach((e) => { world.applyDamage(e, dmg, false); if (world.applyStatus) world.applyStatus(e, "lightning", { dur: 2.5 }); fxRing(e.obj.position, 1.5, 0xfff066); }); },
  meteor(dmg, radius) { if (!world) return; const t = world.nearestEnemy(player.position, 45); const pos = t ? t.obj.position.clone() : player.position.clone(); spawnExplosion(pos, radius); for (const e of world.enemies.slice()) if (!e.dead && e.obj.position.distanceTo(pos) < radius + e.def.radius) world.applyDamage(e, dmg, true); addShake(1.2); },
  shield(secs) { playerShield = Math.max(playerShield, secs); const c = player.position.clone().setY(player.position.y + 1); spriteFlash(c, TEX.glow, 0x7db4ff, 0.8, 3.0, 0.45); auraFollow(secs, 0x66aaff, false); },
  rage(secs) { buffT = Math.max(buffT, secs); const c = player.position.clone().setY(player.position.y + 1); spriteFlash(c, TEX.glow, 0xff6a4a, 0.8, 3.0, 0.45); spawnSparks(c, 0xff8a3a, 20, 9); auraFollow(secs, 0xff5533, true); },
  timestop(radius) { if (world && world.stunNearby) world.stunNearby(player.position, radius, 3.0); timeFreezeFx(Math.min(radius, 12)); },
};
// 직업별 풀: cls로 필터. 티어 실버<골드<프리즘(희귀할수록 강함)
const LV = () => GAME.level;
const TZ = () => _skillCenter(40);
const ACTIVE_SKILLS = [
  // ═══════ 기사 전용 30종 ═══════
  { id: "k_smash", tier: "silver", cls: KNIGHT, name: "방패 강타", desc: "주변 광역 피해", cd: 8, cast: (a) => a.aoe(6, 26 + LV() * 4) },
  { id: "k_heal", tier: "silver", cls: KNIGHT, name: "전투 치유", desc: "체력 35% 회복", cd: 12, cast: (a) => a.heal(0.35) },
  { id: "k_crush", tier: "silver", cls: KNIGHT, name: "분쇄", desc: "광역 피해 + 1초 기절", cd: 10, cast: (a) => { a.aoe(5, 20 + LV() * 3); a.stun(5, 1.0); } },
  { id: "k_taunt", tier: "silver", cls: KNIGHT, name: "도발의 외침", desc: "주변 적 1.8초 기절", cd: 12, cast: () => { groundSmash(7, 0); if (world && world.stunNearby) world.stunNearby(player.position, 7, 1.8); } },
  { id: "k_brace", tier: "silver", cls: KNIGHT, name: "결의", desc: "2.5초간 피해 무효", cd: 14, cast: (a) => a.shield(2.5) },
  { id: "k_charge", tier: "silver", cls: KNIGHT, name: "강타 돌진", desc: "전방으로 돌진하며 타격", cd: 9, cast: () => dashStrike(8, 24 + LV() * 4, 2.6) },
  { id: "k_warcry", tier: "silver", cls: KNIGHT, name: "전투 함성", desc: "8초간 공격 피해 증가", cd: 16, cast: () => applyBuff(() => { PSTATS.dmg += 10; }, () => { PSTATS.dmg -= 10; }, 8, 0xff8a3a) },
  { id: "k_drain", tier: "silver", cls: KNIGHT, name: "흡혈 베기", desc: "광역 피해 + 생명 흡수", cd: 11, cast: () => lifeDrain(5, 18 + LV() * 3, 0.4) },
  { id: "k_bash", tier: "silver", cls: KNIGHT, name: "넉백 강타", desc: "적을 밀치며 피해", cd: 9, cast: () => knockback(6, 3.5, 18 + LV() * 3) },
  { id: "k_guardup", tier: "silver", cls: KNIGHT, name: "수호 강화", desc: "6초간 받는 피해 감소", cd: 16, cast: () => applyBuff(() => { PSTATS.dmgReduce += 0.25; }, () => { PSTATS.dmgReduce -= 0.25; }, 6, 0x66aaff) },
  { id: "k_quake", tier: "gold", cls: KNIGHT, name: "대지 강타", desc: "땅을 찍어 파편+광역 피해·기절", cd: 12, cast: () => groundSmash(9, 45 + LV() * 7) },
  { id: "k_press", tier: "gold", cls: KNIGHT, name: "위압", desc: "강타 + 주변 적 2.2초 기절", cd: 14, cast: () => { groundSmash(8, 20 + LV() * 3); if (world && world.stunNearby) world.stunNearby(player.position, 8, 2.2); } },
  { id: "k_whirl", tier: "gold", cls: KNIGHT, name: "회전 베기", desc: "넓은 광역 피해", cd: 12, cast: (a) => a.aoe(7.5, 42 + LV() * 6) },
  { id: "k_shock", tier: "gold", cls: KNIGHT, name: "충격파", desc: "광범위 파동 피해·기절", cd: 13, cast: () => groundSmash(11, 32 + LV() * 5) },
  { id: "k_ward", tier: "gold", cls: KNIGHT, name: "수호 결계", desc: "4초간 피해 무효", cd: 16, cast: (a) => a.shield(4) },
  { id: "k_flameblade", tier: "gold", cls: KNIGHT, name: "화염 검기", desc: "발밑에 화염 장판(지속 피해)", cd: 14, cast: () => dotZone(player.position.clone(), 6, 30 + LV() * 4, 3, 0xff7a2a, "fire") },
  { id: "k_herodash", tier: "gold", cls: KNIGHT, name: "영웅의 돌진", desc: "길게 돌진하며 강타", cd: 12, cast: () => dashStrike(11, 40 + LV() * 6, 3) },
  { id: "k_berserkcry", tier: "gold", cls: KNIGHT, name: "광전사의 외침", desc: "8초간 공속+피해 증가", cd: 18, cast: () => applyBuff(() => { PSTATS.atkInterval *= 0.6; PSTATS.dmg += 8; }, () => { PSTATS.atkInterval /= 0.6; PSTATS.dmg -= 8; }, 8, 0xff5533) },
  { id: "k_gravsmash", tier: "gold", cls: KNIGHT, name: "중력 강타", desc: "적을 끌어모은 뒤 폭발", cd: 16, cast: () => gravityWell(7, 2.0, 40 + LV() * 6) },
  { id: "k_exec", tier: "gold", cls: KNIGHT, name: "처형 베기", desc: "저체력 적 즉결 처형", cd: 13, cast: () => executeNearby(6, 30 + LV() * 5, 0.3) },
  { id: "k_rage", tier: "prism", cls: KNIGHT, name: "광폭화", desc: "8초간 공격력·공속 폭증", cd: 22, cast: (a) => a.rage(8) },
  { id: "k_immortal", tier: "prism", cls: KNIGHT, name: "불멸", desc: "6초간 피해 무효", cd: 26, cast: (a) => a.shield(6) },
  { id: "k_rift", tier: "prism", cls: KNIGHT, name: "대지 분열", desc: "거대한 대지 강타(초강력)", cd: 22, cast: () => { groundSmash(14, 75 + LV() * 10); groundSmash(8, 0); } },
  { id: "k_hero", tier: "prism", cls: KNIGHT, name: "영웅의 강타", desc: "초광역 피해 + 기절", cd: 20, cast: (a) => { a.aoe(10, 90 + LV() * 10); a.stun(10, 1.5); } },
  { id: "k_lastcry", tier: "prism", cls: KNIGHT, name: "분노의 결전", desc: "광폭화 + 보호막 동시", cd: 28, cast: (a) => { a.rage(7); a.shield(3); } },
  { id: "k_skyfall", tier: "prism", cls: KNIGHT, name: "천공 강타", desc: "표식 후 거대 폭발", cd: 22, cast: () => bombDelayed(120 + LV() * 12, 7, 1.2) },
  { id: "k_grandexec", tier: "prism", cls: KNIGHT, name: "대처형", desc: "광역 처형(강력)", cd: 22, cast: () => executeNearby(8, 45 + LV() * 7, 0.4) },
  { id: "k_earthquake", tier: "prism", cls: KNIGHT, name: "대지진", desc: "광범위 넉백 + 강타", cd: 22, cast: () => { knockback(12, 5, 40 + LV() * 6); groundSmash(12, 0); } },
  { id: "k_avatar", tier: "prism", cls: KNIGHT, name: "불멸의 분노", desc: "광폭화+보호막+회복", cd: 30, cast: (a) => { a.rage(7); a.shield(3); a.heal(0.3); } },
  { id: "k_bloodstorm", tier: "prism", cls: KNIGHT, name: "흡혈 폭풍", desc: "초광역 피해 + 대량 흡수", cd: 24, cast: () => lifeDrain(8, 40 + LV() * 6, 0.5) },
  { id: "k_bladedance", tier: "prism", cls: KNIGHT, name: "검무", desc: "적 사이를 누비며 무적 연속 난무(시점 이동)", cd: 20, cast: () => bladeDance(26 + LV() * 4, 1.3, 4.5) },

  // ═══════ 마법사 전용 30종 ═══════
  { id: "m_frost", tier: "silver", cls: MAGE, name: "빙결", desc: "주변 적 2초 빙결 + 얼음 폭발", cd: 14, cast: (a) => a.frost(7, 2.0, false) },
  { id: "m_nova", tier: "silver", cls: MAGE, name: "화염 폭발", desc: "주변 광역 화염 피해", cd: 8, cast: (a) => a.aoe(6.5, 30 + LV() * 5, 0xff8a3a, "fire") },
  { id: "m_chill", tier: "silver", cls: MAGE, name: "냉기 파동", desc: "근거리 빙결(1.2초)", cd: 10, cast: (a) => a.frost(6, 1.2, false) },
  { id: "m_arcane", tier: "silver", cls: MAGE, name: "비전 탄막", desc: "주변 비전 광역 피해", cd: 9, cast: (a) => a.aoe(7, 26 + LV() * 4, 0x9a6bff) },
  { id: "m_heal", tier: "silver", cls: MAGE, name: "치유술", desc: "체력 35% 회복", cd: 12, cast: (a) => a.heal(0.35) },
  { id: "m_scatter", tier: "silver", cls: MAGE, name: "마력 산탄", desc: "부채꼴 화염구 3발", cd: 9, cast: () => scatterShot("fireball", 3, 18 + LV() * 3, 0.2) },
  { id: "m_firefield", tier: "silver", cls: MAGE, name: "화염 지대", desc: "지속 화염 장판", cd: 13, cast: () => dotZone(TZ(), 6, 28 + LV() * 4, 3, 0xff7a2a, "fire") },
  { id: "m_soul", tier: "silver", cls: MAGE, name: "영혼 흡수", desc: "광역 피해 + 생명 흡수", cd: 11, cast: () => lifeDrain(6, 16 + LV() * 3, 0.4) },
  { id: "m_haste", tier: "silver", cls: MAGE, name: "마력 가속", desc: "8초간 시전 속도 증가", cd: 16, cast: () => applyBuff(() => { PSTATS.atkInterval *= 0.6; }, () => { PSTATS.atkInterval /= 0.6; }, 8, 0x66ccff) },
  { id: "m_frostbomb", tier: "silver", cls: MAGE, name: "서리 폭발", desc: "빙결 + 광역 피해", cd: 12, cast: (a) => { a.frost(6, 1.5, false); a.aoe(5, 20 + LV() * 3, 0x88d4ff); } },
  { id: "m_chain", tier: "gold", cls: MAGE, name: "연쇄 번개", desc: "번개가 적 5명을 연쇄 타격", cd: 10, cast: () => chainLightning(40 + LV() * 7, 5) },
  { id: "m_blizzard", tier: "gold", cls: MAGE, name: "눈보라", desc: "넓은 범위 눈보라로 2.5초 빙결", cd: 16, cast: (a) => a.frost(10, 2.5, true) },
  { id: "m_firestorm", tier: "gold", cls: MAGE, name: "화염 폭풍", desc: "광범위 강력 화염 피해", cd: 14, cast: (a) => a.aoe(9, 52 + LV() * 7, 0xff7a2a, "fire") },
  { id: "m_thunder", tier: "gold", cls: MAGE, name: "낙뢰 연쇄", desc: "번개가 적 7명을 강타", cd: 13, cast: () => chainLightning(55 + LV() * 8, 7) },
  { id: "m_arcaneb", tier: "gold", cls: MAGE, name: "비전 폭발", desc: "넓은 비전 광역 피해", cd: 12, cast: (a) => a.aoe(8, 45 + LV() * 6, 0xb56bff) },
  { id: "m_poisonfog", tier: "gold", cls: MAGE, name: "독성 안개", desc: "지속 독 장판", cd: 13, cast: () => dotZone(TZ(), 7, 30 + LV() * 4, 3.5, 0x7ed957, "poison") },
  { id: "m_gravity", tier: "gold", cls: MAGE, name: "중력장", desc: "적을 끌어모은 뒤 폭발", cd: 16, cast: () => gravityWell(7, 2.2, 45 + LV() * 6) },
  { id: "m_firescatter", tier: "gold", cls: MAGE, name: "화염 산탄", desc: "부채꼴 화염구 5발", cd: 12, cast: () => scatterShot("fireball", 5, 26 + LV() * 4, 0.16) },
  { id: "m_overload", tier: "gold", cls: MAGE, name: "마력 폭주", desc: "8초간 피해·치명타 증가", cd: 18, cast: () => applyBuff(() => { PSTATS.dmg += 18; PSTATS.critChance += 0.2; }, () => { PSTATS.dmg -= 18; PSTATS.critChance -= 0.2; }, 8, 0xb56bff) },
  { id: "m_drainburst", tier: "gold", cls: MAGE, name: "흡혈 폭발", desc: "광역 피해 + 대량 흡수", cd: 14, cast: () => lifeDrain(8, 36 + LV() * 5, 0.45) },
  { id: "m_meteor", tier: "prism", cls: MAGE, name: "메테오", desc: "하늘에서 운석이 쏟아짐(대폭발)", cd: 18, cast: () => meteorStrike(120 + LV() * 12, 8, 5) },
  { id: "m_icestorm", tier: "prism", cls: MAGE, name: "아이스 토네이도", desc: "얼음 회오리가 휘몰아쳐 지속 피해+빙결", cd: 20, cast: () => iceTornado(22 + LV() * 4, 7, 2.6) },
  { id: "m_timestop", tier: "prism", cls: MAGE, name: "시간 정지", desc: "모든 적 3초 정지", cd: 26, cast: (a) => a.timestop(60) },
  { id: "m_inferno", tier: "prism", cls: MAGE, name: "인페르노", desc: "광범위 운석 폭격(다발)", cd: 20, cast: () => meteorStrike(90 + LV() * 10, 10, 8) },
  { id: "m_bliz_ult", tier: "prism", cls: MAGE, name: "절대 영도", desc: "거대 눈보라로 3초 빙결", cd: 24, cast: (a) => a.frost(13, 3.0, true) },
  { id: "m_blackhole", tier: "prism", cls: MAGE, name: "블랙홀", desc: "강력한 중력장 + 대폭발", cd: 24, cast: () => gravityWell(9, 2.6, 70 + LV() * 10) },
  { id: "m_meteorbomb", tier: "prism", cls: MAGE, name: "운석 폭탄", desc: "표식 후 초대형 폭발", cd: 22, cast: () => bombDelayed(150 + LV() * 14, 8, 1.3) },
  { id: "m_hellfire", tier: "prism", cls: MAGE, name: "화염 지옥", desc: "거대 화염 장판(지속)", cd: 22, cast: () => dotZone(TZ(), 9, 50 + LV() * 7, 4, 0xff5a1e, "fire") },
  { id: "m_collapse", tier: "prism", cls: MAGE, name: "시공 붕괴", desc: "시간 정지 + 비전 대폭발", cd: 30, cast: (a) => { a.timestop(60); a.aoe(10, 60 + LV() * 8, 0xb56bff); } },
  { id: "m_cataclysm", tier: "prism", cls: MAGE, name: "대천재해", desc: "초광범위 운석 폭격", cd: 24, cast: () => meteorStrike(70 + LV() * 8, 12, 12) },

  // ═══════ 궁수 전용 30종 (마법진 없음) ═══════
  { id: "a_heal", tier: "silver", cls: ARCHER, name: "응급 치료", desc: "체력 30% 회복", cd: 12, cast: (a) => a.heal(0.30) },
  { id: "a_frostarrow", tier: "silver", cls: ARCHER, name: "빙결 화살", desc: "주변 적 2초 빙결", cd: 14, cast: (a) => a.frost(7, 2.0, false) },
  { id: "a_blast", tier: "silver", cls: ARCHER, name: "폭발 화살", desc: "착탄 지점 광역 폭발", cd: 9, cast: (a) => a.aoe(5.5, 26 + LV() * 4, 0xffaa55, "fire") },
  { id: "a_smoke", tier: "silver", cls: ARCHER, name: "연막탄", desc: "주변 적 1.6초 기절", cd: 12, cast: (a) => a.stun(7, 1.6) },
  { id: "a_poisonshot", tier: "silver", cls: ARCHER, name: "독 사격", desc: "주변 독 구름 피해", cd: 10, cast: (a) => a.aoe(6, 24 + LV() * 4, 0x7ed957, "poison") },
  { id: "a_scatter", tier: "silver", cls: ARCHER, name: "산탄 사격", desc: "부채꼴 화살 3발", cd: 8, cast: () => scatterShot("arrow", 3, 16 + LV() * 3, 0.18) },
  { id: "a_poisonfog", tier: "silver", cls: ARCHER, name: "독 안개", desc: "지속 독 장판", cd: 12, cast: () => dotZone(TZ(), 6, 24 + LV() * 3, 3, 0x7ed957, "poison") },
  { id: "a_roll", tier: "silver", cls: ARCHER, name: "회피 구르기", desc: "전방 회피 돌진(타격)", cd: 8, cast: () => dashStrike(8, 18 + LV() * 3, 2) },
  { id: "a_focus", tier: "silver", cls: ARCHER, name: "집중", desc: "8초간 치명타 확률 증가", cd: 16, cast: () => applyBuff(() => { PSTATS.critChance += 0.25; }, () => { PSTATS.critChance -= 0.25; }, 8, 0xffe08a) },
  { id: "a_drainarrow", tier: "silver", cls: ARCHER, name: "흡혈 화살", desc: "광역 피해 + 생명 흡수", cd: 11, cast: () => lifeDrain(6, 16 + LV() * 3, 0.4) },
  { id: "a_rain", tier: "gold", cls: ARCHER, name: "화살 세례", desc: "넓은 지역에 화살 비", cd: 11, cast: () => arrowRain(28 + LV() * 5, 6, 14) },
  { id: "a_poison", tier: "gold", cls: ARCHER, name: "맹독 살포", desc: "넓은 범위 독 구름 피해", cd: 10, cast: (a) => a.aoe(7, 34 + LV() * 6, 0x7ed957, "poison") },
  { id: "a_volley", tier: "gold", cls: ARCHER, name: "연발 사격", desc: "다수의 화살을 퍼붓는다", cd: 12, cast: () => arrowRain(22 + LV() * 4, 5, 20) },
  { id: "a_frostzone", tier: "gold", cls: ARCHER, name: "빙결 지대", desc: "넓은 범위 2.2초 빙결", cd: 14, cast: (a) => a.frost(9, 2.2, false) },
  { id: "a_barrage", tier: "gold", cls: ARCHER, name: "폭격 화살", desc: "강력한 집중 화살비", cd: 13, cast: () => arrowRain(38 + LV() * 6, 7, 12) },
  { id: "a_cone", tier: "gold", cls: ARCHER, name: "부채꼴 난사", desc: "전방 부채꼴 집중 사격", cd: 11, cast: () => coneStrike(40 + LV() * 6, 16, 0xffe08a) },
  { id: "a_swift", tier: "gold", cls: ARCHER, name: "신속", desc: "8초간 공속·이동 증가", cd: 18, cast: () => applyBuff(() => { PSTATS.atkInterval *= 0.55; WALK *= 1.2; RUN *= 1.2; }, () => { PSTATS.atkInterval /= 0.55; WALK /= 1.2; RUN /= 1.2; }, 8, 0x9fe8ff) },
  { id: "a_multiscatter", tier: "gold", cls: ARCHER, name: "다중 산탄", desc: "부채꼴 화살 5발", cd: 12, cast: () => scatterShot("arrow", 5, 22 + LV() * 4, 0.16) },
  { id: "a_poisonzone", tier: "gold", cls: ARCHER, name: "독 지대", desc: "지속 독 장판(강력)", cd: 13, cast: () => dotZone(TZ(), 7, 30 + LV() * 4, 4, 0x7ed957, "poison") },
  { id: "a_trap", tier: "gold", cls: ARCHER, name: "사냥꾼의 함정", desc: "표식 후 폭발", cd: 14, cast: () => bombDelayed(80 + LV() * 8, 6, 1.0) },
  { id: "a_storm", tier: "prism", cls: ARCHER, name: "강철 폭풍(태풍)", desc: "태풍이 휘몰아치며 화살 폭풍", cd: 20, cast: () => { typhoon(0, 8, 2.4); arrowRain(45 + LV() * 8, 9, 30); } },
  { id: "a_rage", tier: "prism", cls: ARCHER, name: "광폭화", desc: "8초간 공격력·공속 폭증", cd: 22, cast: (a) => a.rage(8) },
  { id: "a_arrowstorm", tier: "prism", cls: ARCHER, name: "화살 폭풍", desc: "초광범위 화살 폭격", cd: 20, cast: () => arrowRain(40 + LV() * 7, 10, 40) },
  { id: "a_frostgale", tier: "prism", cls: ARCHER, name: "빙결 폭풍", desc: "태풍 + 빙결 화살 폭격", cd: 22, cast: (a) => { typhoon(0, 8, 2.2); a.frost(8, 2.2, false); arrowRain(30 + LV() * 5, 8, 20); } },
  { id: "a_fullvolley", tier: "prism", cls: ARCHER, name: "일제 사격", desc: "최강 집중 화살 세례", cd: 24, cast: () => arrowRain(55 + LV() * 9, 7, 24) },
  { id: "a_execshot", tier: "prism", cls: ARCHER, name: "처형 사격", desc: "저체력 적 즉결 처형", cd: 18, cast: () => executeNearby(7, 30 + LV() * 5, 0.35) },
  { id: "a_deathrain", tier: "prism", cls: ARCHER, name: "죽음의 비", desc: "거대 독 장판(지속)", cd: 22, cast: () => dotZone(TZ(), 9, 45 + LV() * 6, 4, 0x9ed957, "poison") },
  { id: "a_pierceblast", tier: "prism", cls: ARCHER, name: "관통 폭격", desc: "전방 초강력 관통 사격", cd: 20, cast: () => coneStrike(70 + LV() * 9, 22, 0xfff0a0) },
  { id: "a_bloodstorm", tier: "prism", cls: ARCHER, name: "흡혈 폭풍", desc: "초광역 피해 + 대량 흡수", cd: 24, cast: () => lifeDrain(9, 40 + LV() * 6, 0.5) },
  { id: "a_eye", tier: "prism", cls: ARCHER, name: "폭풍의 눈", desc: "중력장으로 모은 뒤 화살 세례", cd: 24, cast: () => { gravityWell(8, 2.0, 0); arrowRain(40 + LV() * 6, 7, 24); } },
  { id: "a_grapple", tier: "gold", cls: ARCHER, name: "갈고리 이동사격", desc: "갈고리로 비행하며 화살을 난사", cd: 13, cast: () => grappleShot(16 + LV() * 3, 14) },
  { id: "a_grapplestrike", tier: "prism", cls: ARCHER, name: "강습 사격", desc: "고속 갈고리 비행 + 집중 난사", cd: 18, cast: () => { grappleShot(22 + LV() * 4, 18); } },
];
function slotKey(i) { return ["1", "2", "3", "4"][i]; }
function refreshActives() { UI.setActives(GAME.actives.map((s, i) => ({ key: slotKey(i), name: s ? s.skill.name : null, cdRatio: s ? s.cd / s.skill.cd : 0 }))); }
function castActive(i) {
  if (!GAME.started || paused || GAME.dead) return;
  const slot = GAME.actives[i];
  if (!slot || slot.cd > 0) return;
  slot.cd = slot.skill.cd; slot.skill.cast(SKILL_API);
}
function equipSkill(sk, done) {
  const free = GAME.actives.indexOf(null);
  if (free >= 0) { GAME.actives[free] = { skill: sk, cd: 0 }; UI.toast("장착: " + sk.name + " (" + slotKey(free) + ")"); refreshActives(); done(); }
  else UI.showSlotPicker(GAME.actives.map((s, i) => ({ key: slotKey(i), name: s ? s.skill.name : "비어있음" })), sk.name, (slot) => {
    GAME.actives[slot] = { skill: sk, cd: 0 }; UI.toast("교체: " + sk.name + " (" + slotKey(slot) + ")"); refreshActives(); done();
  });
}
// 티어 희귀도 가중치(깊은 층일수록 상위 티어↑, 좋은 등급일수록 덜 나옴)
function rollTier(floor) {
  const w = { silver: Math.max(10, 70 - floor * 7), gold: floor >= 2 ? Math.min(55, 15 + floor * 6) : 0, prism: floor >= 4 ? Math.min(45, (floor - 3) * 8) : 0 };
  let r = Math.random() * (w.silver + w.gold + w.prism);
  if ((r -= w.silver) < 0) return "silver";
  if ((r -= w.gold) < 0) return "gold";
  return "prism";
}
function openBossReward(cont) {
  paused = true;
  const cls = PSTATS.cls, used = new Set(), ch = [];
  for (let i = 0; i < 3; i++) {
    let pick = null;
    for (let t = 0; t < 8 && !pick; t++) {
      const tier = rollTier(GAME.floor);
      const cand = ACTIVE_SKILLS.filter((s) => s.tier === tier && (!s.cls || s.cls.includes(cls)) && !used.has(s.id));
      if (cand.length) pick = cand[(Math.random() * cand.length) | 0];
    }
    if (!pick) { const cand = ACTIVE_SKILLS.filter((s) => (!s.cls || s.cls.includes(cls)) && !used.has(s.id)); if (cand.length) pick = cand[(Math.random() * cand.length) | 0]; }
    if (pick) { used.add(pick.id); ch.push(pick); }
  }
  if (!ch.length) { paused = false; cont && cont(); return; }
  UI.showBossReward(ch.map((s) => ({ name: s.name, tier: s.tier, desc: s.desc, cd: s.cd })), (idx) => {
    equipSkill(ch[idx], () => { cont && cont(); });   // paused는 다음 층 진입(enterFloor)에서 해제
  }, () => { cont && cont(); });                       // 건너뛰기: 획득 없이 진행
}
function onBossKilled() {
  GAME.gold += 50 * GAME.floor; UI.setGold(GAME.gold);
  GAME.hp = GAME.maxHp; UI.setHP(GAME.hp, GAME.maxHp);   // 층 클리어 시 전체 회복
  UI.hideBoss();
  if (GAME.floor === 20) { UI.banner("🏆 마왕을 물리쳤습니다! 승리!", 3200); addShake(1.4); screenFlash("rgba(255,220,120,0.5)", 0.6, 600); }
  openBossReward(() => UI.floorClear(GAME.floor, () => enterFloor(GAME.floor + 1)));
}
// 보스 봉인 진행 알림: 잡몹을 처치할수록 봉인이 풀린다(잡몹 의의 부여)
function onSealInfo(sealed, killed, goal) {
  if (sealed && killed === 0) { UI.toast("보스 봉인 — 잡몹 " + goal + "마리 처치 시 해제"); }
  else if (sealed) { if (killed % 2 === 0 || goal - killed <= 2) UI.toast("봉인 해제까지 " + (goal - killed) + "마리"); }
  else { UI.banner("보스의 봉인이 풀렸다!", 1800); addShake(0.8); }
}

const loader = new GLTFLoader();
function loadGLB(url) { return new Promise((res, rej) => loader.load(url, res, undefined, rej)); }

// 캐릭터를 키 ~1.8m로 정규화(스킨 모델 바운딩박스가 어긋날 때를 대비해 클램프)
function normScale(obj, targetH) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  let s = size.y > 0.0001 ? targetH / size.y : 1;
  if (!isFinite(s) || s < 0.02 || s > 50) s = 1;   // 비정상값 방어
  return s;
}

// 선택한 캐릭터로 게임 시작 (플레이어 생성 + 월드 + 1층 진입)
function startGame(c) {
  PSTATS = { dmg: c.dmg, attackWindup: c.windup, atkInterval: c.atkInterval || 0.4, atkType: c.atkType, atkClip: c.atkClip, projSpeed: c.projSpeed || 30, aoe: c.aoe || 0, skill: c.skill, skillClip: c.skillClip,
    critChance: 0.2, extraShots: 0, pierce: 0, lifesteal: 0, skillCdMult: 1,
    cls: c.key || "knight", meleeReach: 3.4, dmgReduce: 0, critMult: 0 };
  paused = false; pendingLv = 0; playerShield = 0; buffT = 0; buffs.length = 0; skillLv = {}; lsBudget = 0;
  GAME.actives = [null, null, null, null]; refreshActives();
  parryWindow = 0; iframes = 0; skillCd = 0; dashTime = 0; playerAtkCd = 0;
  GAME.maxHp = c.hp; GAME.hp = c.hp; GAME.level = 1; GAME.xp = 0; GAME.xpNext = 100; GAME.gold = 0; GAME.dead = false;
  WALK = c.speed; RUN = c.speed * 1.6;

  player = c.gltf.scene;
  player.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  charScale = normScale(player, 1.8);
  player.scale.setScalar(charScale);
  player.position.set(0, terrainHeight(0, 0), 0);
  scene.add(player);
  // 동굴/용암 바이옴용 플레이어 주변 광원(기본 꺼짐, applyBiome에서 토글)
  playerLight = new THREE.PointLight(0xffd9a0, 0, 22);
  playerLight.position.set(0, 2.5, 0);   // 항상 씬에 유지(intensity로만 on/off)
  player.add(playerLight);

  mixer = new THREE.AnimationMixer(player);
  c.gltf.animations.forEach((clip) => { actions[clip.name] = mixer.clipAction(clip); });
  // 가산 공격 액션(상체 스윙/캐스팅을 이동/대기 위에 덧씌움) — 캐릭터별 클립
  atkAdd = null;
  const atkClipName = (actions[PSTATS.atkClip] ? PSTATS.atkClip : CLIP.attack);
  if (actions[atkClipName]) {
    const aclip = actions[atkClipName].getClip().clone();
    aclip.tracks = aclip.tracks.filter((t) => t.name.endsWith(".quaternion"));  // 회전만 가산(위치 밀림·크기 축소 방지)
    THREE.AnimationUtils.makeClipAdditive(aclip);
    atkAdd = mixer.clipAction(aclip);
    atkAdd.blendMode = THREE.AdditiveAnimationBlending;
    atkAdd.setLoop(THREE.LoopOnce, 1);
    atkAdd.clampWhenFinished = false;
  }
  // 원샷(사망 등) 종료 시에만 복귀 — 가산 공격 종료는 무시(이동 모션 유지)
  mixer.addEventListener("finished", () => {
    if (!oneShot) return;
    const t = oneShot.then; oneShot = null;
    if (t) t(); else fade(grounded ? CLIP.idle : CLIP.jump, 0.15);
  });
  fade(CLIP.idle, 0);

  world = createWorld({
    scene, camera, terrainHeight, WORLD, CLIP, monsters: monstersRef,
    getPlayer: () => player,
    onEnemyKilled, onBossKilled, onPlayerHit, onDamageNumber, onHit,
    spawnEnemyProjectile, fxRing, fxHit, bossAoE, onSealInfo,
  });
  UI.setHP(GAME.hp, GAME.maxHp); UI.setXP(GAME.xp, GAME.xpNext, GAME.level); UI.setGold(GAME.gold);
  GAME.started = true;
  if (c.skillDesc) UI.toast(c.skillDesc);
  enterFloor(1);
}

Promise.all([
  loadGLB("assets/models/characters/Knight.glb"),
  loadGLB("assets/models/characters/Mage.glb"),
  loadGLB("assets/models/characters/Rogue.glb"),
  loadGLB("assets/models/characters/Skeleton_Minion.glb"),
  loadGLB("assets/models/characters/Skeleton_Warrior.glb"),
  loadGLB("assets/models/characters/Skeleton_Rogue.glb"),
  loadGLB("assets/models/characters/Skeleton_Mage.glb"),
  loadGLB("assets/models/nature/trees.glb"),
  loadGLB("assets/models/nature/pine.glb"),
  loadGLB("assets/models/nature/maple.glb"),
  loadGLB("assets/models/nature/rocks.glb"),
  loadGLB("assets/models/nature/bushes.glb"),
  loadGLB("assets/models/nature/grass.glb"),
  loadGLB("assets/models/monsters/dragon.glb"),
  loadGLB("assets/models/monsters/dragon_evolved.glb"),
  loadGLB("assets/models/monsters/demon.glb"),
  loadGLB("assets/models/monsters/blue_demon.glb"),
  loadGLB("assets/models/monsters/orc.glb"),
  loadGLB("assets/models/monsters/orc_enemy.glb"),
  loadGLB("assets/models/monsters/yeti.glb"),
  loadGLB("assets/models/monsters/golem.glb"),
  loadGLB("assets/models/monsters/golem_evolved.glb"),
  loadGLB("assets/models/monsters/mushroom_king.glb"),
  loadGLB("assets/models/monsters/ghost.glb"),
  loadGLB("assets/models/monsters/ghost_skull.glb"),
  loadGLB("assets/models/monsters/dino.glb"),
  loadGLB("assets/models/monsters/wizard.glb"),
]).then(([gKnight, gMage, gRogue, gMinion, gWarrior, gSkRogue, gSkMage, gTrees, gPine, gMaple, gRocks, gBushes, gGrass,
          gDragon, gDragonE, gDemon, gBlueDemon, gOrc, gOrcE, gYeti, gGolem, gGolemE, gMushK, gGhost, gGhostSk, gDino, gWizard]) => {
  // 식생/바위 프로토타입 저장(바이옴마다 enterFloor에서 골라 배치)
  NP = {
    leafy: [].concat(makePrototypes(gTrees, 5.5), makePrototypes(gMaple, 5.5)),
    pine: makePrototypes(gPine, 6.5),
    rocks: makePrototypes(gRocks, 1.4),
    bushes: makePrototypes(gBushes, 1.1),
    grass: makePrototypes(gGrass, 0.8),
  };

  // Quaternius 생물 리그 클립 매핑(3종 규격)
  const C_FLY = { idle: "CharacterArmature|Flying_Idle", walk: "CharacterArmature|Flying_Idle", run: "CharacterArmature|Fast_Flying", attack: "CharacterArmature|Headbutt", death: "CharacterArmature|Death", hit: "CharacterArmature|HitReact", jump: "CharacterArmature|Fast_Flying" };
  const C_WALK = { idle: "CharacterArmature|Idle", walk: "CharacterArmature|Walk", run: "CharacterArmature|Run", attack: "CharacterArmature|Punch", death: "CharacterArmature|Death", hit: "CharacterArmature|HitReact", jump: "CharacterArmature|Jump" };
  const C_SIMPLE = { idle: "CharacterArmature|Idle", walk: "CharacterArmature|Walk", run: "CharacterArmature|Walk", attack: "CharacterArmature|Bite_Front", death: "CharacterArmature|Death", hit: "CharacterArmature|HitRecieve", jump: "CharacterArmature|Jump" };
  const _mk = (g, h, clips) => ({ gltf: g, scale: normScale(g.scene, h), creature: true, clips });
  monstersRef = {
    minion: { gltf: gMinion, scale: normScale(gMinion.scene, 1.7) },
    warrior: { gltf: gWarrior, scale: normScale(gWarrior.scene, 1.9) },
    rogue: { gltf: gSkRogue, scale: normScale(gSkRogue.scene, 1.75) },
    mage: { gltf: gSkMage, scale: normScale(gSkMage.scene, 1.8) },
    // 신규 CC0 생물(Quaternius, poly.pizza)
    dragon: _mk(gDragon, 2.4, C_FLY), dragon_evolved: _mk(gDragonE, 2.8, C_FLY),
    demon: _mk(gDemon, 2.3, C_FLY), blue_demon: _mk(gBlueDemon, 2.1, C_WALK),
    orc: _mk(gOrc, 2.0, C_WALK), orc_enemy: _mk(gOrcE, 1.8, C_SIMPLE),
    yeti: _mk(gYeti, 2.2, C_SIMPLE), golem: _mk(gGolem, 1.9, C_FLY),
    golem_evolved: _mk(gGolemE, 2.4, C_FLY), mushroom_king: _mk(gMushK, 2.1, C_WALK),
    ghost: _mk(gGhost, 1.9, C_FLY), ghost_skull: _mk(gGhostSk, 1.9, C_FLY),
    dino: _mk(gDino, 1.9, C_WALK), wizard: _mk(gWizard, 1.8, C_SIMPLE),
  };

  // 선택 가능한 캐릭터 (공격 방식 차별화)
  const CHARS = {
    knight: { gltf: gKnight, key: "knight", name: "기사", role: "근접·패링", hp: 170, dmg: 16, speed: 6.5, windup: 170, atkInterval: 0.36,
      atkType: "melee", atkClip: "1H_Melee_Attack_Slice_Diagonal",
      skill: "parry", skillClip: "Block", skillDesc: "F: 패링 — 타이밍 맞춰 막으면 주변 적 기절!",
      desc: "빠른 근접 베기. 패링 성공 시 적 기절" },
    mage:   { gltf: gMage,   key: "mage", name: "마법사", role: "원거리·광역", hp: 95, dmg: 26, speed: 6.0, windup: 300, atkInterval: 0.95,
      atkType: "fireball", atkClip: "Spellcast_Shoot", projSpeed: 26, aoe: 3.6,
      skill: "blink", skillClip: "Spellcast_Raise", skillDesc: "F: 블링크 — 순간이동(회피)",
      desc: "파이어볼 광역. 느리지만 강하다(공속↓·딜↑)" },
    archer: { gltf: gRogue,  key: "archer", name: "궁수", role: "원거리·연사", hp: 110, dmg: 13, speed: 7.0, windup: 180, atkInterval: 0.34,
      atkType: "arrow", atkClip: "2H_Ranged_Shoot", projSpeed: 48,
      skill: "dodge", skillClip: "Dodge_Forward", skillDesc: "F: 구르기 — 빠른 회피(무적)",
      desc: "화살 빠른 연사(단일). 공속이 빠르다" },
  };

  document.getElementById("loading").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  // 개발용: ?auto=knight|mage|archer 면 선택 건너뛰고 바로 시작
  const auto = new URLSearchParams(location.search).get("auto");
  if (auto && CHARS[auto]) { startGame(CHARS[auto]); const f = parseInt(new URLSearchParams(location.search).get("floor") || "1", 10); if (f > 1) enterFloor(f); if (location.search.includes("draft")) setTimeout(() => addXP(500), 900); return; }
  UI.showCharSelect(
    Object.keys(CHARS).map((k) => ({ key: k, name: CHARS[k].name, role: CHARS[k].role, hp: CHARS[k].hp, dmg: CHARS[k].dmg, speed: CHARS[k].speed, desc: CHARS[k].desc })),
    (key) => startGame(CHARS[key])
  );
}).catch((err) => {
  document.getElementById("loading").textContent = "로드 실패: " + err.message + " (로컬 서버로 열어 주세요)";
  console.error(err);
});

// ---------- 루프 ----------
const clock = new THREE.Clock();
const statsEl = () => document.getElementById("stats");
let fpsT = 0, frames = 0, fps = 0;
const tmpDir = new THREE.Vector3();

function update(dt) {
  if (!player) return;
  if (paused) return;                  // 레벨업 스킬 선택 중 일시정지

  // 입력 → 이동 방향(카메라 yaw 기준)
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz -= 1;
  if (keys.KeyS || keys.ArrowDown) iz += 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1;
  if (keys.KeyD || keys.ArrowRight) ix += 1;
  if (GAME.dead) { ix = 0; iz = 0; }
  const moving = ix !== 0 || iz !== 0;
  const running = moving && (keys.ShiftLeft || keys.ShiftRight);
  if (attackSlow > 0) attackSlow -= dt;
  if (playerAtkCd > 0) playerAtkCd -= dt;
  if (skillCd > 0) skillCd -= dt;
  if (iframes > 0) iframes -= dt;
  if (parryWindow > 0) parryWindow -= dt;
  if (playerShield > 0) playerShield -= dt;
  if (buffT > 0) buffT -= dt;
  for (const s of GAME.actives) if (s && s.cd > 0) s.cd -= dt;
  const speed = (running ? RUN : WALK) * (attackSlow > 0 ? 0.55 : 1);

  if (moving) {
    const ang = Math.atan2(ix, iz) + cam.yaw;       // 카메라 기준 진행각
    tmpDir.set(Math.sin(ang), 0, Math.cos(ang));
    player.position.x += tmpDir.x * speed * dt;
    player.position.z += tmpDir.z * speed * dt;
    // 월드 경계
    const lim = WORLD * 0.47;
    player.position.x = THREE.MathUtils.clamp(player.position.x, -lim, lim);
    player.position.z = THREE.MathUtils.clamp(player.position.z, -lim, lim);
    // 모델이 진행 방향을 바라보게(부드럽게)
    const targetRot = Math.atan2(tmpDir.x, tmpDir.z);
    let d = targetRot - player.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    player.rotation.y += d * Math.min(1, dt * 12);
  }

  // 이동 중 카메라 자동 추적: 전진(W 성분) 이동이면 카메라가 캐릭터 등 뒤로 부드럽게 따라온다.
  // 순수 좌우 스트레이프(A/D만)·후진(S)은 시점을 고정해 둔다. 수동 드래그 직후엔 양보(camManualT).
  if (camManualT > 0) camManualT -= dt;
  if (AUTO_FOLLOW_CAM && moving && iz < 0 && camManualT <= 0 &&
      grappleT <= 0 && dashTime <= 0 && !GAME.dead) {
    let cd = (player.rotation.y + Math.PI) - cam.yaw;   // 캐릭터 등 뒤를 향하도록
    while (cd > Math.PI) cd -= Math.PI * 2; while (cd < -Math.PI) cd += Math.PI * 2;
    cam.yaw += cd * Math.min(1, dt * CAM_FOLLOW_RATE);
  }

  // 점프 / 중력 / 접지
  // 구르기 대시(무적 동안 빠른 이동)
  if (dashTime > 0) {
    dashTime -= dt;
    const ds = 15, lim = WORLD * 0.47;
    player.position.x = THREE.MathUtils.clamp(player.position.x + dashDir.x * ds * dt, -lim, lim);
    player.position.z = THREE.MathUtils.clamp(player.position.z + dashDir.z * ds * dt, -lim, lim);
  }

  // 던전 벽/기둥 충돌(폐쇄형 바이옴)
  const col = dungeon.collide(player.position.x, player.position.z, 0.6);
  player.position.x = col.x; player.position.z = col.z;

  const groundY = terrainHeight(player.position.x, player.position.z);
  if (grappleT > 0) {                                  // 갈고리 이동: 앵커로 호 그리며 비행(중력 무시)
    grappleT -= dt;
    const k = THREE.MathUtils.clamp(1 - grappleT / grappleDur, 0, 1);
    player.position.x = grappleFrom.x + (grappleTo.x - grappleFrom.x) * k;
    player.position.z = grappleFrom.z + (grappleTo.z - grappleFrom.z) * k;
    player.position.y = terrainHeight(player.position.x, player.position.z) + Math.sin(k * Math.PI) * 2.6;
    vy = 0; grounded = false;
  } else {
    if (grounded && keys.Space && !GAME.dead) { vy = JUMP_V; grounded = false; }
    vy += GRAV * dt;
    player.position.y += vy * dt;
    if (player.position.y <= groundY) { player.position.y = groundY; vy = 0; grounded = true; }
  }

  // 애니메이션 상태(원샷 중·사망 중이 아니면)
  if (!oneShot && !GAME.dead) {
    if (!grounded) fade(CLIP.jump, 0.1);
    else if (running) fade(CLIP.run, 0.15);
    else if (moving) fade(CLIP.walk, 0.15);
    else fade(CLIP.idle, 0.2);
  }

  // 추적 카메라(플레이어 머리 주위 구면 오프셋)
  const head = player.position.clone().add(new THREE.Vector3(0, 1.5, 0));
  const cx = Math.sin(cam.yaw) * Math.cos(cam.pitch);
  const cy = Math.sin(cam.pitch);
  const cz = Math.cos(cam.yaw) * Math.cos(cam.pitch);
  const desired = head.clone().add(new THREE.Vector3(cx, cy, cz).multiplyScalar(cam.dist));
  // 카메라가 지형 아래로 들어가지 않게
  const camGround = terrainHeight(desired.x, desired.z) + 1.2;
  if (desired.y < camGround) desired.y = camGround;
  if (desired.y > dungeon.ceilingY - 1.3) desired.y = dungeon.ceilingY - 1.3;   // 천장 위로 못 나가게
  if (!camReady) { camera.position.copy(desired); camReady = true; }  // 첫 프레임 즉시 정착(시작 스윙 방지)
  else camera.position.lerp(desired, Math.min(1, dt * 8));
  camera.lookAt(head);
  if (shakeT > 0) {                                  // 타격/폭발 시 화면 흔들림
    shakeT -= dt; const s = shakeMag;
    camera.position.x += (Math.random() * 2 - 1) * s * 0.35;
    camera.position.y += (Math.random() * 2 - 1) * s * 0.35;
    camera.position.z += (Math.random() * 2 - 1) * s * 0.35;
    if (shakeT <= 0) shakeMag = 0;
  }

  // 몬스터 갱신 + 투사체 + 파티클 + 보스 체력바
  if (world) {
    world.update(dt);
    updateProjectiles(dt);
    updateProjectileLights();          // 고정 조명 풀을 활성 투사체에 재배정(렉 방지)
    updateBursts(dt);
    updateTrails(dt); updateSparks(dt); updateFxSprites(dt);
    updateEmitters(dt); updateShards(dt); updateDecals(dt); updateEmbers(dt); updateAnims(dt); updateBuffs(dt);
    if (lsBudget > 0) lsBudget = Math.max(0, lsBudget - GAME.maxHp * 0.2 * dt);   // 흡혈 회복 예산 회복(0.6초 주기)
    updateBolts(dt); updateMeteors(dt); updateWarns(dt);
    refreshActives();                  // Q/W/E/R 쿨다운 표시 갱신
    const b = world.boss;
    if (b && !b.dead) UI.setBoss((b.sealed ? "🔒 " : "") + b.def.name, b.hp / b.maxHp); else UI.hideBoss();
  }
}

function animate() {
  requestAnimationFrame(animate);
  const real = Math.min(0.05, clock.getDelta());
  let dt = real;
  if (hitstop > 0) { hitstop -= real; dt = real * 0.06; }   // 히트스톱: 게임을 아주 잠깐 슬로우
  if (mixer) mixer.update(dt);
  update(dt);
  // 화면 암전 펄스(메테오 등) — 어두워졌다가 서서히 복귀
  if (exposureT > 0) { exposureT -= dt; exposureMul += (1 - exposureMul) * Math.min(1, dt * 2.5); } else exposureMul = 1;
  renderer.toneMappingExposure = 0.85 * exposureMul;
  composer.render();

  frames++; fpsT += dt;
  if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
  const s = statsEl();
  if (s && player) s.innerHTML = `FPS ${fps}<br/>위치 X ${player.position.x.toFixed(0)} Z ${player.position.z.toFixed(0)}<br/>고도 ${player.position.y.toFixed(1)}`;
}
animate();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
