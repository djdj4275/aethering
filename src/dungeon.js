// dungeon.js — 밀폐형(enclosed) 던전 지오메트리 생성 + 플레이어 충돌
// 동굴/용암 같은 폐쇄 바이옴에서 사방 돌벽 + 천장 + 내부 기둥으로 '석조 던전' 느낌을 만든다.
// 개방 바이옴(숲/설원)에서는 아무것도 만들지 않고 충돌도 비활성화한다.
import * as THREE from "three";

export function createDungeon({ scene, terrainHeight, WORLD }) {
  const _texLoader = new THREE.TextureLoader();
  let group = null;                 // 현재 던전 지오메트리를 담는 그룹(밀폐일 때만 존재)
  let enclosed = false;             // 현재 밀폐 상태인가
  let arena = 56;                   // 방 반(half) 크기 — 안쪽 면이 ±arena
  let ceilingY = Infinity;          // 천장 높이(개방형이면 Infinity) — 카메라 클램프용
  let pillars = [];                 // 원형 충돌체 [{ x, z, r }]
  const disposables = [];           // clear 시 dispose 할 지오메트리/머티리얼

  // ---------- 돌 머티리얼(벽용) ----------
  // rock_diff/nor/rough 텍스처를 RepeatWrapping으로 로드. repeat은 벽 크기에 맞춰 설정한다.
  function makeWallMat(repX, repY, tint) {
    const map = _texLoader.load("assets/textures/rock_diff.jpg");
    const nor = _texLoader.load("assets/textures/rock_nor_gl.jpg");
    const rgh = _texLoader.load("assets/textures/rock_rough.jpg");
    [map, nor, rgh].forEach((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repX, repY);
      t.anisotropy = 4;
    });
    map.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap: nor, roughnessMap: rgh,
      color: tint != null ? tint : 0x9a9aa2, roughness: 1, metalness: 0,
    });
    disposables.push(map, nor, rgh, mat);
    return mat;
  }

  function addMesh(geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    disposables.push(geo);
    group.add(m);
    return m;
  }

  // ---------- 정리 ----------
  function clear() {
    if (group) {
      scene.remove(group);
      group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      group = null;
    }
    for (const d of disposables) { if (d && d.dispose) d.dispose(); }
    disposables.length = 0;
    pillars = [];
  }

  // ---------- 재건축 ----------
  // opt = { enclosed:bool, ceiling:bool, arena:number(half-size), wallTint:hex(optional) }
  function rebuild(opt) {
    clear();
    opt = opt || {};
    enclosed = !!opt.enclosed;
    ceilingY = Infinity;
    if (!enclosed) { return; }       // 개방 바이옴: 아무것도 만들지 않음(충돌도 없음)

    arena = opt.arena != null ? opt.arena : 56;
    const ceiling = !!opt.ceiling;
    const tint = opt.wallTint;

    group = new THREE.Group();
    scene.add(group);

    // ----- 1) 사방 둘레 벽 (안쪽 면이 ±arena) -----
    const THICK = 4;                 // 벽 두께
    const yBottom = -8, yTop = 30;   // 지형 언덕(최대 ~15)을 넉넉히 덮도록 충분히 높게
    const wallH = yTop - yBottom;    // ~24
    const wallY = (yTop + yBottom) / 2;
    const span = arena * 2 + THICK;  // 모서리를 채우도록 약간 길게
    // 텍스처 반복: 벽 길이 ~ (arena/4), 높이 ~ 4
    const repLen = Math.max(1, Math.round(arena / 4));
    const wallMat = makeWallMat(repLen, 4, tint);

    // 벽의 중심을 (arena + THICK/2)에 두면 안쪽 면이 정확히 ±arena에 온다.
    const off = arena + THICK / 2;
    // +Z / -Z 벽 (X축 방향으로 span)
    addMesh(new THREE.BoxGeometry(span, wallH, THICK), wallMat, 0, wallY, off);
    addMesh(new THREE.BoxGeometry(span, wallH, THICK), wallMat, 0, wallY, -off);
    // +X / -X 벽 (Z축 방향으로 span)
    addMesh(new THREE.BoxGeometry(THICK, wallH, span), wallMat, off, wallY, 0);
    addMesh(new THREE.BoxGeometry(THICK, wallH, span), wallMat, -off, wallY, 0);

    // ----- 2) 천장 (하늘 가림) -----
    if (ceiling) {
      // 아래에서 보이도록 아래를 향하는 평면. 어두운 돌/검정 머티리얼.
      const ceilGeo = new THREE.PlaneGeometry(span, span);
      const ceilMat = new THREE.MeshStandardMaterial({
        color: 0x0a0a0e, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      });
      disposables.push(ceilMat);
      const ceil = new THREE.Mesh(ceilGeo, ceilMat);
      ceil.rotation.x = Math.PI / 2;   // 평면을 수평으로 + 아래(-Y)를 향하게
      ceilingY = 26;                   // 지형 언덕 위로 충분히 높게(카메라가 이 아래로 제한됨)
      ceil.position.set(0, ceilingY, 0);
      ceil.receiveShadow = true;
      disposables.push(ceilGeo);
      group.add(ceil);
    }

    // ----- 3) 내부 기둥 (엄폐/미로 느낌) -----
    // 중심 반경 12 안은 비워둔다(스폰 영역). 방 안쪽으로만 배치.
    const pillarMat = makeWallMat(2, 4, tint);
    const nPillars = 10;
    let placed = 0, tries = 0;
    const inner = arena - 6;         // 벽에서 살짝 떨어뜨림
    while (placed < nPillars && tries < nPillars * 10) {
      tries++;
      const x = THREE.MathUtils.randFloatSpread(inner * 2);
      const z = THREE.MathUtils.randFloatSpread(inner * 2);
      if (Math.hypot(x, z) < 12) continue;            // 스폰 영역 확보
      // 다른 기둥과 너무 가깝지 않게
      let ok = true;
      for (const p of pillars) { if (Math.hypot(x - p.x, z - p.z) < 8) { ok = false; break; } }
      if (!ok) continue;
      const r = THREE.MathUtils.randFloat(1.5, 2.5);
      const base = terrainHeight(x, z);
      const h = 28;                                   // 천장까지 닿는 높이감
      const geo = new THREE.CylinderGeometry(r, r * 1.15, h, 10);
      addMesh(geo, pillarMat, x, base + h / 2 - 1, z);  // 지형에 살짝 박히게
      pillars.push({ x, z, r });
      placed++;
    }
  }

  // ---------- 충돌 ----------
  // (x,z) 를 방 안쪽 + 기둥 바깥으로 보정한 위치를 반환한다.
  function collide(x, z, radius) {
    if (!enclosed) return { x, z };
    radius = radius || 0;
    // 사각형 방 경계 클램프(벽 통과 방지)
    const lim = Math.max(0, arena - radius);
    x = THREE.MathUtils.clamp(x, -lim, lim);
    z = THREE.MathUtils.clamp(z, -lim, lim);
    // 기둥: 겹치면 기둥 중심에서 바깥으로 밀어냄
    for (const p of pillars) {
      const dx = x - p.x, dz = z - p.z;
      const minD = p.r + radius;
      let d = Math.hypot(dx, dz);
      if (d < minD) {
        if (d < 1e-4) { x = p.x + minD; z = p.z; }    // 정확히 중심이면 임의 방향으로
        else { const k = minD / d; x = p.x + dx * k; z = p.z + dz * k; }
      }
    }
    return { x, z };
  }

  return { rebuild, collide, clear, get ceilingY() { return ceilingY; } };
}
