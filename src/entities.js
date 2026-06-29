// entities.js — 던전 몬스터/보스 (4종 적 + 4종 보스 고유패턴 + 원거리 캐스터)
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

// 일반 적: 병사(기본)/전사(탱커)/도적(빠름)/마법사(원거리)
const ENEMY_DEFS = {
  minion: { name: "해골 병사", model: "minion", mscale: 0.95, hp: 22, dmg: 5, speed: 2.6, aggro: 18, radius: 0.7, score: 14, barY: 2.2, atkClip: "1H_Melee_Attack_Chop" },
  warrior: { name: "해골 전사", model: "warrior", mscale: 1.05, hp: 55, dmg: 11, speed: 2.9, aggro: 18, radius: 0.95, score: 40, barY: 2.9, atkClip: "2H_Melee_Attack_Chop" },
  rogue: { name: "해골 도적", model: "rogue", mscale: 0.95, hp: 30, dmg: 8, speed: 4.5, aggro: 22, radius: 0.7, score: 30, barY: 2.3, atkClip: "1H_Melee_Attack_Stab" },
  caster: { name: "해골 술사", model: "mage", mscale: 1.0, hp: 34, dmg: 9, speed: 2.4, aggro: 26, radius: 0.8, score: 45, barY: 2.6, ranged: true, prefRange: 11, atkClip: "Spellcast_Shoot" },
};
// 보스: 층마다 순환, 각자 고유 패턴 + 고유 공격 모션
const BOSS_DEFS = {
  lord: { name: "해골 군주", model: "warrior", mscale: 2.0, hp: 240, dmg: 18, speed: 2.6, aggro: 200, radius: 1.7, score: 300, barY: 4.5, pattern: "slam", mob: "leap", atkClip: "2H_Melee_Attack_Chop", patClip: "2H_Melee_Attack_Spinning" },
  archmage: { name: "해골 대마법사", model: "mage", mscale: 1.9, hp: 200, dmg: 13, speed: 2.2, aggro: 200, radius: 1.6, score: 320, barY: 4.4, pattern: "volley", mob: "blink", ranged: true, prefRange: 15, atkClip: "Spellcast_Shoot", patClip: "Spellcast_Long" },
  reaper: { name: "해골 사신", model: "rogue", mscale: 2.0, hp: 210, dmg: 16, speed: 3.2, aggro: 200, radius: 1.6, score: 340, barY: 4.4, pattern: "charge", mob: null, atkClip: "1H_Melee_Attack_Stab", patClip: "1H_Melee_Attack_Jump_Chop" },
  necro: { name: "강령술사", model: "minion", mscale: 2.1, hp: 230, dmg: 12, speed: 2.4, aggro: 200, radius: 1.7, score: 360, barY: 4.6, pattern: "summon", mob: "blink", atkClip: "1H_Melee_Attack_Chop", patClip: "Spellcasting" },
};
const BOSS_ORDER = ["lord", "archmage", "reaper", "necro"];

function makeHealthBar(w) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.16), new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true, opacity: 0.85 }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.16), new THREE.MeshBasicMaterial({ color: 0x49d65a, depthTest: false }));
  bg.renderOrder = 998; fill.renderOrder = 999;
  g.add(bg); g.add(fill); g.userData.fill = fill; g.userData.w = w; g.visible = false;
  return g;
}

export function createWorld(ctx) {
  const { scene, terrainHeight, getPlayer, camera, CLIP } = ctx;
  const enemies = [];
  let boss = null, curMult = 1, arena = 70;
  const tmp = new THREE.Vector3();

  function actionsFor(obj, gltf) {
    const mixer = new THREE.AnimationMixer(obj);
    const acts = {};
    (gltf.animations || []).forEach((c) => { acts[c.name] = mixer.clipAction(c); });
    let addAtk = null;
    if (acts[CLIP.attack]) {
      const aclip = acts[CLIP.attack].getClip().clone();
      aclip.tracks = aclip.tracks.filter((t) => t.name.endsWith(".quaternion"));
      THREE.AnimationUtils.makeClipAdditive(aclip);
      addAtk = mixer.clipAction(aclip); addAtk.blendMode = THREE.AdditiveAnimationBlending;
      addAtk.setLoop(THREE.LoopOnce, 1); addAtk.clampWhenFinished = false;
    }
    return { mixer, acts, cur: null, addAtk };
  }
  function play(ent, key, opts) {
    opts = opts || {};
    const loop = opts.loop !== false, fade = opts.fade == null ? 0.2 : opts.fade;
    const name = CLIP[key] || key;
    const a = ent.anim.acts[name];
    if (!a || ent.anim.cur === a) return;
    if (ent.anim.cur) ent.anim.cur.fadeOut(fade);
    a.reset(); a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop; a.fadeIn(fade).play(); ent.anim.cur = a;
  }
  // 적/보스 공격: 클립별로 다른 전신 모션을 한 번 재생(끝나면 AI가 idle/walk로 복귀)
  function playAttack(e, clip, dur) {
    const a = e.anim.acts[clip] || e.anim.acts[CLIP.attack];
    if (!a) return;
    if (e.anim.cur && e.anim.cur !== a) e.anim.cur.fadeOut(0.08);
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.fadeIn(0.08).play();
    e.anim.cur = a; e.atkAnim = dur || 0.55;
  }

  function spawnEnemy(def, x, z, mult, isBoss) {
    const M = ctx.monsters[def.model];
    const obj = cloneSkeleton(M.gltf.scene);
    obj.scale.setScalar(M.scale * def.mscale);
    const mats = [];   // 적별 머티리얼 복제(개별 피격 플래시용 — 공유 머티리얼이면 전부 깜빡임)
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; if (o.material) { o.material = o.material.clone(); mats.push(o.material); } } });
    obj.position.set(x, terrainHeight(x, z), z);
    scene.add(obj);
    const bar = makeHealthBar(def.radius * 1.7); bar.position.y = def.barY; obj.add(bar);
    const e = {
      def, obj, anim: actionsFor(obj, M.gltf), bar, isBoss: !!isBoss,
      hp: def.hp * mult, maxHp: def.hp * mult, dmg: def.dmg * mult, score: Math.round(def.score * mult),
      ranged: !!def.ranged, prefRange: def.prefRange || 0,
      home: new THREE.Vector3(x, 0, z), atkCd: Math.random() * 1.2, dead: false, stun: 0,
      wanderT: 0, wanderDir: Math.random() * 7, moving: false, atkAnim: 0,
      patternCd: isBoss ? 2.5 : 0, telegraph: 0, charge: 0, chargeDir: new THREE.Vector3(), chargeHit: false,
      mobCd: isBoss ? 5 : 0, leap: 0, leapDir: new THREE.Vector3(), leapSpeed: 0, leapHit: false,
      zoneCd: isBoss ? 3.5 : 0, volleyAlt: false, mats: mats, flash: 0,
    };
    play(e, "idle"); enemies.push(e); return e;
  }

  // ---------- 층 시작 ----------
  function clearFloor() { enemies.forEach((e) => scene.remove(e.obj)); enemies.length = 0; boss = null; }
  function rndPlace(minR, maxR) { const a = Math.random() * Math.PI * 2, r = THREE.MathUtils.randFloat(minR, maxR); return [Math.cos(a) * r, Math.sin(a) * r]; }
  function startFloor(floor, opt) {
    clearFloor();
    arena = (opt && opt.arena) || 70;
    curMult = 1 + 0.16 * (floor - 1);
    const lim = arena - 8;
    // 적 구성: 층이 깊을수록 도적·전사·술사 비중↑
    const n = Math.min(16, 4 + floor * 2);
    const pool = [["minion", 5]];
    if (floor >= 1) pool.push(["rogue", Math.min(4, 1 + floor)]);
    if (floor >= 2) pool.push(["warrior", Math.min(4, floor)]);
    if (floor >= 2) pool.push(["caster", Math.min(4, floor - 1)]);
    const bag = []; pool.forEach(([k, w]) => { for (let i = 0; i < w; i++) bag.push(k); });
    for (let i = 0; i < n; i++) {
      const k = bag[(Math.random() * bag.length) | 0] || "minion";
      const p = rndPlace(14, lim); spawnEnemy(ENEMY_DEFS[k], p[0], p[1], curMult);
    }
    const bdef = BOSS_DEFS[BOSS_ORDER[(floor - 1) % BOSS_ORDER.length]];
    const bp = rndPlace(Math.min(28, lim - 6), lim);
    boss = spawnEnemy(bdef, bp[0], bp[1], 1 + 0.3 * (floor - 1), true);
  }

  // ---------- 전투 ----------
  function playerAttack(dmg, isCrit, reach) {
    const p = getPlayer(); if (!p) return false;
    const R = reach || 3.4;
    const facing = new THREE.Vector3(Math.sin(p.rotation.y), 0, Math.cos(p.rotation.y));
    let hit = false;
    for (const e of enemies) {
      if (e.dead) continue;
      tmp.subVectors(e.obj.position, p.position); tmp.y = 0;
      if (tmp.length() > R) continue;
      tmp.normalize(); if (tmp.dot(facing) < 0.3) continue;
      hitEnemy(e, dmg, isCrit); hit = true;
    }
    return hit;
  }
  function hitEnemy(e, dmg, isCrit) {
    if (!e || e.dead) return;
    e.hp = Math.max(0, e.hp - dmg); e.bar.visible = true; e.flash = 0.12;   // 피격 시 흰 발광 플래시
    ctx.onDamageNumber(e.obj.position, e.def.barY, dmg, isCrit ? "crit" : "hit");
    if (ctx.fxHit) ctx.fxHit(e.obj.position, isCrit ? 0xffd23f : 0xfff1a8);
    if (ctx.onHit) ctx.onHit(dmg);
    if (!e.isBoss) { tmp.subVectors(e.obj.position, getPlayer().position); tmp.y = 0; tmp.normalize(); e.obj.position.addScaledVector(tmp, 0.25); }
    if (e.hp <= 0) killEnemy(e);
  }
  function killEnemy(e) {
    e.dead = true; e.bar.visible = false;
    if (e.anim.addAtk) e.anim.addAtk.stop();
    play(e, "death", { loop: false, fade: 0.15 });
    const idx = enemies.indexOf(e); if (idx >= 0) enemies.splice(idx, 1);
    setTimeout(() => scene.remove(e.obj), 2500);
    if (e.isBoss) { boss = null; ctx.onBossKilled(); } else ctx.onEnemyKilled(e.def.name, e.score);
  }
  function nearestNpc() { return null; }
  function stunNearby(pos, radius, dur) {
    for (const e of enemies) if (!e.dead && e.obj.position.distanceTo(pos) <= radius) { e.stun = e.isBoss ? dur * 0.5 : dur; e.atkCd = Math.max(e.atkCd, 0.4); }
  }

  // ---------- AI 헬퍼 ----------
  function faceMove(e, dir, sp, dt) { e.obj.position.addScaledVector(dir, sp * dt); e.obj.rotation.y = Math.atan2(dir.x, dir.z); }

  function meleeAI(e, dt, d, toP) {
    if (d < e.def.aggro) {
      if (d > 2.0) { toP.normalize(); faceMove(e, toP, e.def.speed, dt); play(e, e.def.speed > 3.5 ? "run" : "walk"); }
      else {
        e.obj.rotation.y = Math.atan2(toP.x, toP.z);
        if (e.atkCd <= 0) {
          e.atkCd = e.def.speed > 3.5 ? 1.1 : 1.6; playAttack(e, e.def.atkClip); const dmg = e.dmg;
          setTimeout(() => { if (!e.dead && e.stun <= 0 && getPlayer() && e.obj.position.distanceTo(getPlayer().position) < 3.0) ctx.onPlayerHit(dmg); }, 300);
        } else if (e.atkAnim <= 0) { play(e, "idle"); }
      }
    } else wander(e, dt);
  }
  function rangedAI(e, dt, d, toP) {
    if (d < e.def.aggro) {
      const pr = e.prefRange || 11;
      if (d < pr * 0.6) { toP.normalize(); faceMove(e, toP, -e.def.speed, dt); play(e, "walk"); }
      else if (d > pr * 1.15) { toP.normalize(); faceMove(e, toP, e.def.speed, dt); play(e, "walk"); }
      else { e.obj.rotation.y = Math.atan2(toP.x, toP.z); if (e.atkAnim <= 0) play(e, "idle"); }
      if (e.atkCd <= 0 && d < pr * 1.7) {
        e.atkCd = e.isBoss ? 1.6 : 2.0; playAttack(e, e.def.atkClip, 0.7);
        const o = e.obj.position.clone(); o.y += 1.4;
        const pc = getPlayer().position.clone(); pc.y += 1.0;
        const dir = pc.sub(o).normalize();   // 3D 조준(점프한 플레이어도 맞힘)
        setTimeout(() => { if (!e.dead && e.stun <= 0) ctx.spawnEnemyProjectile(o.clone(), { x: dir.x, y: dir.y, z: dir.z }, e.dmg); }, 240);
      }
    } else wander(e, dt);
  }
  function wander(e, dt) {
    e.wanderT -= dt;
    if (e.wanderT <= 0) { e.wanderT = THREE.MathUtils.randFloat(2, 5); e.wanderDir = Math.random() * Math.PI * 2; e.moving = Math.random() < 0.6; }
    if (e.moving) {
      const dx = Math.sin(e.wanderDir), dz = Math.cos(e.wanderDir);
      const nx = e.obj.position.x + dx * e.def.speed * 0.4 * dt, nz = e.obj.position.z + dz * e.def.speed * 0.4 * dt;
      if (Math.hypot(nx - e.home.x, nz - e.home.z) < 16) { e.obj.position.x = nx; e.obj.position.z = nz; e.obj.rotation.y = Math.atan2(dx, dz); }
      play(e, "walk");
    } else play(e, "idle");
  }

  // ---------- 보스 고유 패턴 ----------
  function bossPattern(e, dt, d) {
    if (e.telegraph > 0) { e.telegraph -= dt; if (e.telegraph <= 0) slamHit(e); return; }
    if (e.charge > 0) return;
    e.patternCd -= dt;
    if (e.patternCd > 0) return;
    const pat = e.def.pattern;
    if (pat === "slam" && d < 11) { e.patternCd = 4.5; e.telegraph = 0.6; playAttack(e, e.def.patClip, 1.0); ctx.fxRing(e.obj.position, 6, 0xffcc55); }
    else if (pat === "volley") { e.patternCd = 3.0; if (e.volleyAlt) ringBurst(e, 12); else volley(e, 5); e.volleyAlt = !e.volleyAlt; }
    else if (pat === "charge" && d > 2.5 && d < 26) { e.patternCd = 3.6; e.charge = 0.6; e.chargeHit = false; playAttack(e, e.def.patClip, 0.6); e.chargeDir.subVectors(getPlayer().position, e.obj.position).setY(0).normalize(); }
    else if (pat === "summon") { e.patternCd = 6.5; playAttack(e, e.def.patClip, 0.9); summon(e, 2); ctx.fxRing(e.obj.position, 3, 0x8a4fff); }
  }
  function slamHit(e) {
    ctx.fxRing(e.obj.position, 6.5, 0xff7a30);
    if (getPlayer() && e.obj.position.distanceTo(getPlayer().position) < 6.5) ctx.onPlayerHit(Math.round(e.dmg * 1.5));
  }
  function ringBurst(e, n) {
    playAttack(e, e.def.atkClip || "Spellcast_Shoot", 0.8);
    const o = e.obj.position.clone(); o.y += 1.5;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ctx.spawnEnemyProjectile(o.clone(), { x: Math.sin(a), y: 0, z: Math.cos(a) }, e.dmg); }
  }
  function volley(e, n) {
    playAttack(e, e.def.atkClip || "Spellcast_Shoot", 0.8);
    const base = tmp.subVectors(getPlayer().position, e.obj.position).setY(0).normalize();
    const baseAng = Math.atan2(base.x, base.z);
    const o = e.obj.position.clone(); o.y += 1.6;
    for (let i = 0; i < n; i++) {
      const a = baseAng + (i - (n - 1) / 2) * 0.18;
      setTimeout(() => { if (!e.dead) ctx.spawnEnemyProjectile(o.clone(), { x: Math.sin(a), z: Math.cos(a) }, e.dmg); }, 200 + i * 60);
    }
  }
  function summon(e, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 2;
      spawnEnemy(ENEMY_DEFS.minion, e.obj.position.x + Math.cos(a) * r, e.obj.position.z + Math.sin(a) * r, curMult);
    }
  }
  // 보스 이동기: 도약(점프 돌진) / 블링크(순간이동)
  function startLeap(e, d) {
    e.leap = 0.55; e.leapHit = false;
    e.leapDir.subVectors(getPlayer().position, e.obj.position).setY(0).normalize();
    e.leapSpeed = Math.max(2, d - 3) / 0.55;
    playAttack(e, e.def.patClip || e.def.atkClip, 0.7);
  }
  function doBlink(e) {
    ctx.fxRing(e.obj.position, 2.4, 0x9b6bff);
    const pl = getPlayer().position, a = Math.random() * Math.PI * 2, dist = e.def.prefRange || 12, lim = arena - 4;
    const nx = THREE.MathUtils.clamp(pl.x + Math.cos(a) * dist, -lim, lim);
    const nz = THREE.MathUtils.clamp(pl.z + Math.sin(a) * dist, -lim, lim);
    e.obj.position.set(nx, terrainHeight(nx, nz), nz);
    ctx.fxRing(e.obj.position, 2.4, 0x9b6bff);
  }
  function nearestEnemy(pos, maxDist) {
    let best = null, bd = maxDist || 30;
    for (const e of enemies) { if (e.dead) continue; const d = e.obj.position.distanceTo(pos); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  // ---------- 매 프레임 ----------
  function update(dt) {
    const p = getPlayer(); if (!p) return;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      e.anim.mixer.update(dt);
      if (e.flash > 0) { e.flash -= dt; const k = Math.max(0, e.flash / 0.12) * 0.9; for (let mi = 0; mi < e.mats.length; mi++) if (e.mats[mi].emissive) e.mats[mi].emissive.setScalar(k); }
      if (e.dead) continue;
      // 체력바 빌보드
      if (e.bar.visible) {
        e.bar.quaternion.copy(camera.quaternion);
        const ratio = e.hp / e.maxHp, f = e.bar.userData.fill;
        f.scale.x = Math.max(0.001, ratio); f.position.x = -(1 - ratio) * (e.bar.userData.w / 2);
        f.material.color.setHex(ratio > 0.5 ? 0x49d65a : ratio > 0.25 ? 0xe0b000 : 0xd63b3b);
      }
      if (e.stun > 0) { e.stun -= dt; play(e, "idle"); e.obj.position.y = terrainHeight(e.obj.position.x, e.obj.position.z); continue; }
      // 보스 도약(점프 돌진) 진행 중
      if (e.leap > 0) {
        e.leap -= dt;
        const prog = 1 - Math.max(0, e.leap) / 0.55;
        e.obj.position.x += e.leapDir.x * e.leapSpeed * dt;
        e.obj.position.z += e.leapDir.z * e.leapSpeed * dt;
        e.obj.position.y = terrainHeight(e.obj.position.x, e.obj.position.z) + Math.sin(prog * Math.PI) * 4.5;
        e.obj.rotation.y = Math.atan2(e.leapDir.x, e.leapDir.z);
        play(e, "run");
        if (e.leap <= 0) {
          e.obj.position.y = terrainHeight(e.obj.position.x, e.obj.position.z);
          if (e.def.pattern === "slam") slamHit(e); else ctx.fxRing(e.obj.position, 4.5, 0xffaa55);
        }
        continue;
      }
      if (e.atkCd > 0) e.atkCd -= dt;
      if (e.atkAnim > 0) e.atkAnim -= dt;

      tmp.subVectors(p.position, e.obj.position); tmp.y = 0;
      const d = tmp.length();
      const toP = tmp.clone();

      if (e.isBoss) {
        e.mobCd -= dt; e.zoneCd -= dt;
        bossPattern(e, dt, d);
        // 텔레그래프 지역기: 플레이어 발밑에 경고 후 폭발 → 가만히 있으면 맞음(걷기만으론 못 피하게 압박)
        if (e.zoneCd <= 0 && d < 26 && ctx.bossAoE) {
          e.zoneCd = 4.5;
          ctx.bossAoE(getPlayer().position.clone(), e.isBoss ? 5.5 : 4, Math.round(e.dmg * 1.4), 1.0);
        }
        if (e.mobCd <= 0 && e.charge <= 0 && e.telegraph <= 0) {
          if (e.def.mob === "leap" && d > 5 && d < 32) { e.mobCd = 6; startLeap(e, d); continue; }
          if (e.def.mob === "blink") { e.mobCd = 5.5; doBlink(e); }   // 주기적 재배치(거리 무관)
        }
      }

      if (e.charge > 0) {                          // 돌진 중
        e.charge -= dt;
        faceMove(e, e.chargeDir, 13, dt); play(e, "run");
        if (!e.chargeHit && e.obj.position.distanceTo(p.position) < 2.4) { e.chargeHit = true; ctx.onPlayerHit(Math.round(e.dmg * 1.2)); }
      } else if (e.telegraph > 0) {                // 슬램 예비동작(공격 모션 유지)
        e.obj.rotation.y = Math.atan2(toP.x, toP.z);
      } else if (e.ranged) {
        rangedAI(e, dt, d, toP);
      } else {
        meleeAI(e, dt, d, toP);
      }
      e.obj.position.y = terrainHeight(e.obj.position.x, e.obj.position.z);
    }
  }

  return {
    update, playerAttack, nearestNpc, nearestEnemy, startFloor, enemies, stunNearby,
    applyDamage: (e, dmg, crit) => hitEnemy(e, dmg, crit),
    get boss() { return boss; },
  };
}
