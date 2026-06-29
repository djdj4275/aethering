# 리소스 출처 (Credits)

## 3D 엔진
- **Three.js r160** (MIT) — `vendor/three.module.js`, `vendor/GLTFLoader.js`, `vendor/OrbitControls.js`,
  `vendor/SkeletonUtils.js`. <https://threejs.org>

## 캐릭터 모델
- **RobotExpressive** — Tomás Laulhé / **Quaternius**, 수정 Don McCurdy. **CC0 (퍼블릭 도메인)**.
  three.js 예제 동봉 모델. 애니메이션: Idle, Walking, Running, Jump, Punch, Death, Wave, Dance 등.
  파일: `assets/models/RobotExpressive.glb`.

## 식생/바위 (3D 모델)
- **Quaternius — "Ultimate Stylized Nature Pack"** (나무/소나무/단풍/바위/덤불/풀), **CC0**.
  poly.pizza 경유 직접 다운로드. 파일: `assets/models/nature/*.glb`.

## 지형 텍스처 (바이옴별, 전부 CC0)
- **Poly Haven** — `leafy_grass`(숲), `snow_02`(설원), `aerial_rocks_02`(동굴·용암) — diffuse/normal/rough, 1k.
  파일: `assets/textures/{grass,snow,rock}_*.jpg`.

## 하늘
- **three.js `Sky`** 셰이더(물리 기반 대기 산란, MIT). `vendor/jsm/objects/Sky.js`.

## 캐릭터 / 몬스터 (리깅+애니메이션)
- 플레이어: **KayKit "Character Pack: Adventurers" — Knight** (Kay Lousberg), **CC0**.
- 몬스터(해골): **KayKit "Character Pack: Skeletons" — Minion/Warrior/Rogue/Mage** (Kay Lousberg), **CC0**.
  공식 GitHub(KayKit-Game-Assets)에서 GLB 직접 다운로드. 76~95개 애니메이션 클립 내장.
  파일: `assets/models/characters/*.glb`. (기존 RobotExpressive는 미사용)
- 몬스터(생물): **Quaternius "Ultimate Animated Monsters"** (Quaternius), **CC0**. poly.pizza 경유 GLB 다운로드.
  드래곤/악마/오크/예티/골렘/버섯왕/원혼/공룡/마법사 등 14종. `CharacterArmature|*` 클립 규격을 모델별 매핑으로 통합.
  파일: `assets/models/monsters/*.glb`. 20층 보스 로스터·깊은 층 잡몹에 사용.

## VFX (이펙트)
- **화염 폭발 스프라이트시트** — `assets/vfx/sheet_explosion.png` (320×320, 64px 프레임 5열×23프레임).
  Phaser 예제 공개 에셋(explosion.png). 폭발·메테오·연쇄번개 착탄·원소 폭발에 애니메이션으로 사용.
- **Kenney "Particle Pack"** (Kenney.nl), **CC0**. 글로우/충격파 링/스파크/별/마법진/연기/참격/전격 등 스킬·이펙트 스프라이트 전반.
  `Calinou/kenney-particle-pack`(GitHub) 경유 PNG 다운로드. 파일: `assets/vfx/kenney/*.png`.
  (런타임 캔버스 생성 방식을 폐기하고 전부 외부 소스로 교체)
- **연기/폭발 스프라이트시트** — `assets/vfx/smoke.png`, `sheet_explosion.png`(애니메이션 폭발).

리소스는 직접 제작하지 않고 위 무료(CC0/MIT) 소스에서 받아 적용했습니다.
