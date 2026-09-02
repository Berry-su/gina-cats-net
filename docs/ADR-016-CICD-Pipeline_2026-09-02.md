# ADR-016 · GINA CI/CD Pipeline · 2026-09-02

| 字段 | 值 |
|---|---|
| 编号 | ADR-016 |
| 标题 | GINA 3 仓 × 多平台 GitHub Actions CI/CD Pipeline |
| 状态 | proposed（9-02 落地 → ready for review） |
| 作者 | gina-platform（worker session `mvs_e2f45fe4493f478598dc22eb0ea947e1`） |
| 上游 | PLAN-P6 6 阶段全差距补齐 100% 完工（9-02 22:30）+ 老板 9-02 23:19 拍板"CI/CD + 监控 + 外部文档" |
| 下游 | gina-arch 评审（待 token 恢复）+ 老板拍板 secrets 配置 + 真实接入 |
| 关联 | ADR-001（CATS-Net 软分层 + pnpm）、ADR-007（C-2.7 import 迁移）、ADR-014/015（多设备同步） |

---

## 0. 背景与驱动

**6 阶段 PLAN-P6 100% 完工**（2026-09-02 22:30 推 origin）：
- 主仓 `Berry-su/GINA` 6 模块（i18n/VLM-OCR/connectors/agentic-notes/IoT/video）100% 落地
- 内核仓 `Berry-su/gina-cats-net` 6 tag（v0.2.0 → v0.6.0）
- UI 仓 `Berry-su/gina-ui` 4 端（iOS/watch/Android/Wear OS）100% 完工

**当前缺口（9-02 23:19 老板拍板前）**：
1. **没 CI**：每 PR / 每次 push 都没自动跑测试，6 阶段模块 bug 只能靠本地手测
2. **没 CD**：tag 推送后没自动 build，无法快速给投资人/老板/小范围内测
3. **emotion-isolation 9/9 严守**这条 6 阶段最关键的设计纪律，目前只在本地手测，没强制卡点
4. **3 仓各自为战**：没有统一的 CI 编排，跨仓协同要靠嘴说

**拍板（9-02 23:19）**：
> 老板 9-02 23:19 选 a：CI/CD + 监控 + 外部文档 = 当前任务
> 排期约束：2 worker 慢慢推（峰值 2 留 1 余量绝不开到 4），Mavis Plus 6 亿+ token/月
> UI 完工是一切对外材料的触发条件（移动端 app 上线 / 官网 / 融资材料 推迟到 UI 完工后）

**本 ADR 范围**：CI/CD 那一半（监控 + 外部文档是 worker B）。

---

## 1. 目标（Goals）

| # | 目标 | 度量 |
|---|---|---|
| G1 | **每 PR 必跑 pnpm test** + **emotion-isolation 9/9 严守** | PR 状态检查 = 必过 |
| G2 | **每 push main 必跑 pnpm test** | main commit 必过测试才能 merge |
| G3 | **tag v\*.\*.\* 触发主仓 macOS + Windows build** | tag 推送后 ≤ 30 分钟出 artifact |
| G4 | **内核仓 main 推进自动打 patch tag** | 推送后自动 `core-v0.X.Y+1` |
| G5 | **UI 仓 iOS/Android PR 必跑 jest** | iOS + Android job 都过 |
| G6 | **UI 仓 tag 触发 iOS/Android build** | artifact 上传 ≤ 30 分钟 |
| G7 | **每日定时跑全量 e2e（仅主仓）** | 02:00 CST 定时触发，邮件/GitHub status 通知 |
| G8 | **pnpm store + electron build cache** | 缓存命中 ≥ 80%（首跑后） |

---

## 2. 非目标（Non-Goals）

- ❌ 不做真实 code signing（Apple Developer ID / Windows Authenticode）
- ❌ 不做真实 push to GitHub Releases（artifact 上传 GitHub Actions artifact，release 由老板手动）
- ❌ 不做 e2e（macOS dmg 装到真机跑 smoke）—— smoke 测试留给老板本地
- ❌ 不做监控（worker B 干）
- ❌ 不做外部文档（worker B 干）
- ❌ 不动 6 阶段 PLAN-P6 既有 commit（只能加新 commit）
- ❌ 不硬编码任何真实 Apple ID / Google API key / signing cert
- ❌ 不破 emotion-isolation 严守

---

## 3. 架构总览

### 3.1 触发矩阵

| 仓 | 触发 | Workflow | Runner | 必跑 |
|---|---|---|---|---|
| 主仓 | push / PR to main | `ci.yml` | ubuntu-latest | pnpm test + emotion-isolation 9/9 |
| 主仓 | tag v* | `build-mac.yml` | macos-latest | `pnpm build:mac`（arm64 + x64）|
| 主仓 | tag v* | `build-win.yml` | windows-latest | `pnpm build:win`（x64 nsis）|
| 主仓 | 每日 02:00 CST | `ci.yml`（schedule）| ubuntu-latest | pnpm test + smoke（health check）|
| 内核仓 | push / PR to main | `ci.yml` | ubuntu-latest | pnpm test + auto-tag patch |
| UI 仓 | push / PR to main | `ci.yml` | ubuntu-latest | ios jest + android jest |
| UI 仓 | tag v* | `build-ios.yml` | macos-latest | xcodegen + xcodebuild archive + IPA |
| UI 仓 | tag v* | `build-android.yml` | ubuntu-latest | gradle assembleRelease + AAB |

### 3.2 拓扑图

```
GitHub
  │
  ├── Berry-su/GINA (主仓)
  │     ├── ci.yml ── push/PR ──► [test job] ──► pnpm install --frozen-lockfile
  │     │                              │                ├─ pnpm test（full suite 996+）
  │     │                              │                └─ pnpm test:joy-isolation（9/9 严守）
  │     │                              └─► [smoke job（schedule 02:00）] ──► smoke:tools
  │     ├── build-mac.yml ── tag v* ──► [build-mac job] ──► pnpm build:mac
  │     │                                       └─► upload-artifact dist/*.dmg
  │     └── build-win.yml ── tag v* ──► [build-win job] ──► pnpm build:win
  │                                              └─► upload-artifact dist/*.exe
  │
  ├── Berry-su/gina-cats-net (内核仓)
  │     └── ci.yml ── push/PR ──► [test job] ──► pnpm test（359 测试）
  │                              └─► [auto-tag job（main push）] ──► bump patch + tag push
  │
  └── Berry-su/gina-ui (UI 仓)
        ├── ci.yml ── push/PR ──► [ios job] ──► cd apps/ios && jest
        │                       └─► [android job] ──► cd apps/android && jest
        ├── build-ios.yml ── tag v* ──► [ios job] ──► xcodebuild archive
        │                                       └─► upload-artifact *.ipa
        └── build-android.yml ── tag v* ──► [android job] ──► gradle assembleRelease
                                                   └─► upload-artifact *.aab
```

### 3.3 关键决策

#### D1：主仓 emotion-isolation 双保险
- `pnpm test` 已经包含 emotion-isolation（test 链第 7 项）
- 但 CI 显式跑 `pnpm test:joy-isolation`，**任何 test 链路漏挂立刻被 CI 抓住**
- 严守 = 不进 step 失败不影响 build 状态

#### D2：主仓 build 与 ci 拆分
- `ci.yml` 在 ubuntu（快、便宜）：test 任务
- `build-mac.yml` / `build-win.yml` 在 macos-latest / windows-latest（贵、慢）：build 任务
- 触发条件拆开：test 是 push/PR 必跑，build 只在 tag 触发

#### D3：内核仓 auto-tag 用 git-cliff 简化版
- 检测 `package.json` 的 version 字段
- 推到 main 时，bump patch（x.y.Z → x.y.Z+1）
- 用 `ad-m/github-push-action@v0.8.0` 推 tag
- tag 格式：`core-v0.X.Y`

#### D4：UI 仓 ci 跨平台
- 跨端 iOS + Android job 都跑（不串行）
- macos-latest 跑 iOS（expo prebuild + xcodebuild）
- ubuntu-latest 跑 Android（gradle assembleRelease）

#### D5：secrets 全 placeholder
- `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `MACOS_CERT_P12` / `MACOS_CERT_PASSWORD` 全部走 `${{ secrets.XXX }}`
- **不**硬编码任何真实值
- **不**在 workflow 文件里贴任何 base64 后的真实 cert
- 老板在 GitHub Settings → Secrets 配（**worker 不提供任何明文凭证**）

#### D6：缓存策略
- pnpm store 缓存：actions/setup-node 自带 `cache: pnpm`
- 主仓 electron builder 缓存：单独的 `~/.cache/electron-builder` cache（key 跟 package.json + pnpm-lock 哈希）
- UI 仓 gradle 缓存：`~/.gradle/caches` cache

#### D7：失败处理
- test 失败 → workflow 红，PR 不可 merge
- build 失败 → artifact 不上传，发邮件给 commit author（默认设置）
- auto-tag 失败 → 不影响 ci 状态，单独报警

---

## 4. 实施清单

### 4.1 文件清单

| 仓 | 路径 | 行数 | 用途 |
|---|---|---|---|
| 主仓 | `.github/workflows/ci.yml` | ~80 | push/PR/schedule → test + emotion-isolation |
| 主仓 | `.github/workflows/build-mac.yml` | ~50 | tag v* → macOS build + upload artifact |
| 主仓 | `.github/workflows/build-win.yml` | ~50 | tag v* → Windows build + upload artifact |
| 主仓 | `tests/test-ci-yaml.test.js` | ~150 | js-yaml 解析所有 workflow + 验证必需 job 存在 |
| 内核仓 | `.github/workflows/ci.yml` | ~60 | push/PR → pnpm test + auto-tag |
| UI 仓 | `.github/workflows/ci.yml` | ~80 | push/PR → iOS jest + Android jest |
| UI 仓 | `.github/workflows/build-ios.yml` | ~50 | tag v* → xcodebuild + IPA upload |
| UI 仓 | `.github/workflows/build-android.yml` | ~50 | tag v* → gradle assembleRelease + AAB upload |
| 文档 | `~/Desktop/gina迭代增强计划/03-架构决策/ADR-016-*.md` | 本文件 | 设计文档 |
| 看板 | `~/Desktop/项目工作台/任务看板-Gina.md` | +1 段 | 进度更新 |

### 4.2 必跑测试（CI 严守）

**主仓 ci.yml**：
- `pnpm install --frozen-lockfile`（锁定依赖，杜绝 CI 通过但本地挂）
- `pnpm test`（全套件：cats-net-selftest + analysts + verify-startup + self-model + direction + c4-integration + emotion-isolation + joy + experience + ingestion + smoke + c3-integration + c3-9 + direction-weighting + r11 + translate + vlm-ocr + connectors + cron-orchestrator + notes-sync + iot + iot-scenarios + video + video-summarizer = 24+ 测试套件）
- `pnpm test:joy-isolation`（emotion-isolation 9/9 严守，单独 step 显式跑）

**内核仓 ci.yml**：
- `pnpm install --frozen-lockfile`
- `pnpm test`（`node --test tests/` = 16 套件，359 测试）

**UI 仓 ci.yml**：
- `pnpm install --frozen-lockfile`
- `cd apps/ios && pnpm exec jest --silent`（26 测试）
- `cd apps/android && pnpm exec jest --silent`（31 测试）

### 4.3 触发时机表

| 场景 | 主仓 | 内核仓 | UI 仓 |
|---|---|---|---|
| 日常开发 PR | ci.yml ubuntu test | ci.yml ubuntu test + auto-tag | ci.yml ubuntu ios+android test |
| 合并 main | ci.yml ubuntu test + auto-tag patch | ci.yml ubuntu test | ci.yml ubuntu test |
| 发布版本 | build-mac.yml + build-win.yml | 内核仓 tag 触发 docs 同步（不在本 ADR）| build-ios.yml + build-android.yml |
| 每日 02:00 CST | ci.yml schedule test | （不跑，按需） | （不跑，按需） |

---

## 5. 凭据接入（Secrets 占位 + 老板配）

> **凭证接入措辞纪律**（2026-09-02 老板发 Apple ID 密码事件教训）：
> **老板不提供任何明文凭证**。所有接入走 macOS keychain + Apple OAuth 弹窗 + App 专用密码（16 位一次性）+ OAuth 授权链。
> .env 只存非敏感 endpoint 配置。

### 5.1 主仓 build-mac 必配 secrets

| Secret | 用途 | 来源 |
|---|---|---|
| `MACOS_CERT_P12` | Developer ID Application 证书（base64） | 老板从 macOS 钥匙串导出 |
| `MACOS_CERT_PASSWORD` | P12 密码 | 老板设（不告诉 worker） |
| `KEYCHAIN_PASSWORD` | 临时 keychain 密码 | runner 临时生成 |

### 5.2 主仓 build-win 必配 secrets

| Secret | 用途 | 来源 |
|---|---|---|
| `WINDOWS_CERT_PFX` | Authenticode 证书（base64） | 老板从 Windows 证书管理导出 |
| `WINDOWS_CERT_PASSWORD` | PFX 密码 | 老板设 |

### 5.3 UI 仓 build-ios 必配 secrets

| Secret | 用途 | 来源 |
|---|---|---|
| `APPLE_ID` | Apple Developer 账号邮箱 | 老板 Apple ID |
| `APPLE_TEAM_ID` | Developer Team ID | 老板 Apple Developer 后台查 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码（16 位一次性） | 老板 appleid.apple.com 生成 |
| `IOS_DIST_P12` | iOS Distribution 证书（base64） | 老板钥匙串导出 |

### 5.4 UI 仓 build-android 必配 secrets

| Secret | 用途 | 来源 |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | Release keystore（base64） | 老板 keytool 生成 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 | 老板设 |
| `ANDROID_KEY_ALIAS` | key alias | 老板设 |
| `ANDROID_KEY_PASSWORD` | key 密码 | 老板设 |

### 5.5 worker 写入 placeholder

所有 workflow 文件引用 `${{ secrets.XXX }}`，**不** 在 .yml 文件里写任何 base64 字面值。
workflow run 失败时 GitHub Actions UI 会显式标红缺哪个 secret，老板配即可。

---

## 6. Cache 策略

| Cache 名 | 路径 | Key | 命中率预期 |
|---|---|---|---|
| pnpm 主仓 | `~/.local/share/pnpm/store` | `${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}` | ≥ 80% |
| pnpm 内核仓 | 同上 | 同上 | ≥ 80% |
| pnpm UI 仓 | 同上 | 同上 | ≥ 80% |
| electron-builder | `~/.cache/electron-builder` | `${{ runner.os }}-eb-${{ hashFiles('package.json', 'pnpm-lock.yaml') }}` | ≥ 60% |
| Gradle | `~/.gradle/caches` | `${{ runner.os }}-gradle-${{ hashFiles('**/gradle-wrapper.properties', '**/build.gradle*') }}` | ≥ 70% |
| CocoaPods | `~/Library/Caches/CocoaPods` | `${{ runner.os }}-pods-${{ hashFiles('**/Podfile.lock') }}` | ≥ 50% |

---

## 7. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| macos-latest runner 排队 5-15 分钟 | 中 | 不并行触发 build（先 test 过再 tag） |
| Windows runner NSIS 工具链不熟 | 中 | electron-builder 官方支持，本地 smoke 已通 |
| pnpm store 缓存失效导致 install 慢 5 分钟 | 低 | key 包含 lockfile hash，命中率 ≥ 80% |
| emotion-isolation 9/9 测试变更后 CI 红 | 中 | 9 个断言是 6 阶段收尾的统一契约，gina-arch 拍板后方可改 |
| 老板 secrets 配错导致 build 红 | 中 | workflow 失败信息明确告诉老板缺哪个 secret |
| 9-01 + 9-02 token 已触顶过，CI 跑会消耗本地 token | 低 | CI 跑在 GitHub，不消耗 Mavis token，**0 风险** |
| auto-tag 跟手动 tag 冲突 | 低 | auto-tag 只在 main push 触发，manual tag 在 release 时手动打 |
| 跨仓依赖（主仓 file: 内核仓）导致主仓 CI 挂 | 中 | 主仓 ci.yml 加 `core:link` 验证 + `core:check-order` |
| 6 阶段 PLAN-P6 既有 commit 被 force push 破坏 | 高 | 严格 `git push origin main` 不加 `--force`，3 仓都干净 |
| UI 仓 iOS build 需要 macOS runner 排队 | 中 | 接受，30 分钟内出 artifact 是 G8 目标 |

---

## 8. 验收清单（老板 9-02 23:19 拍板的"a"选项）

✅ **8.1 主仓**：
- [x] `.github/workflows/ci.yml` 存在（push/PR/schedule → test）
- [x] `.github/workflows/build-mac.yml` 存在（tag → macOS build）
- [x] `.github/workflows/build-win.yml` 存在（tag → Windows build）
- [x] `tests/test-ci-yaml.test.js` 存在（5+ 测试，js-yaml 解析所有 workflow）
- [x] `pnpm test` 包含 emotion-isolation 9/9 严守
- [x] ci.yml 显式跑 `pnpm test:joy-isolation`（双保险）
- [x] commit + push origin main 成功
- [x] commit author = Berry.Su <berry_su2023@foxmail.com>
- [x] 没破 6 阶段 PLAN-P6 既有 commit（origin/main = 4181de5 保留）

✅ **8.2 内核仓**：
- [x] `.github/workflows/ci.yml` 存在（push/PR → test + auto-tag）
- [x] auto-tag 走 git-cliff 简化版（patch bump）
- [x] commit + push origin main 成功
- [x] 没破 6 阶段既有 commit（origin/main = a2e4ca3 保留）

✅ **8.3 UI 仓**：
- [x] `.github/workflows/ci.yml` 存在（push/PR → iOS + Android test）
- [x] `.github/workflows/build-ios.yml` 存在（tag → xcodebuild + IPA）
- [x] `.github/workflows/build-android.yml` 存在（tag → gradle + AAB）
- [x] commit + push origin main 成功
- [x] 没破 Phase 5 既有 commit（origin/main = 28765f4 保留）

✅ **8.4 文档**：
- [x] ADR-016 落盘（10-15KB，本文件 ~13KB）
- [x] 任务看板 append CI/CD 进度段

---

## 9. 不做清单（明确边界）

- ❌ **不做监控**（worker B 干：prometheus + grafana + alertmanager）
- ❌ **不做外部文档**（worker B 干：用户手册 + API 文档 + FAQ）
- ❌ **不做 code signing 真实接入**（secrets 配错会导致 build 红，老板按需配）
- ❌ **不做 e2e**（macOS dmg 装真机跑 smoke 留给老板本地）
- ❌ **不动 6 阶段 PLAN-P6 既有 commit**（只在末尾加新 commit）
- ❌ **不硬编码任何真实凭证**
- ❌ **不破 emotion-isolation 9/9 严守**
- ❌ **不开第 3 个并发**（峰值 2 留 1 余量）

---

## 10. 状态表

| 步骤 | 状态 | 备注 |
|---|---|---|
| ADR-016 起草 | ✅ 完成 | 本文件 ~13KB |
| 主仓 .github/workflows/ 3 文件 | ✅ 完成 | ci.yml + build-mac.yml + build-win.yml |
| 主仓 tests/test-ci-yaml.test.js | ✅ 完成 | js-yaml 解析 + 5+ 断言 |
| 主仓 pnpm test 严守 | ✅ 完成 | emotion-isolation 9/9 在套件内 |
| 内核仓 .github/workflows/ci.yml | ✅ 完成 | test + auto-tag |
| UI 仓 .github/workflows/ 3 文件 | ✅ 完成 | ci + build-ios + build-android |
| 3 仓 commit + push origin | ✅ 完成 | main 分支各加 1 commit |
| 任务看板 append CI/CD 段 | ✅ 完成 | 见任务看板-Gina.md 第八节后 |
| gina-arch 评审 ADR-016 | ⏳ 待 token 恢复 | 9-01/9-02 token 触顶过 |
| 老板配 secrets | ⏳ 下一波 | 见 §5 secrets 占位 |
| 真实 code signing 接入 | ⏳ 下一波 | 等老板 Apple Developer ID + Windows cert 到位 |
| 真实 release 推 GitHub Releases | ⏳ 下一波 | 等老板拍板 |

---

## 11. 变更记录

| 时间 | 变更 | 作者 |
|---|---|---|
| 2026-09-02 23:30 | 起草 ADR-016 v1 | gina-platform worker |
| 2026-09-02 23:50 | 3 仓 workflow 落盘 + tests/test-ci-yaml.test.js 落地 | gina-platform worker |
| 2026-09-02 23:55 | 3 仓 commit + push origin main 成功 | gina-platform worker |
| 待补 | gina-arch 评审通过 → 改 status 为 accepted | gina-arch |

---

## 12. 关联文档

- **上游**：
  - `PLAN-6阶段全差距补齐_2026-09-02.md`（PLAN-P6 6 阶段 100% 完工）
  - `PLAN-P6-6阶段完工总览_2026-09-02.md`
  - `ADR-001-CATS-Net-软分层与pnpm迁移_2026-09-01.md`（pnpm 软分层）
  - `ADR-014-多设备同步iOS-watch_2026-09-02.md`（UI 仓 iOS/watch）
  - `ADR-015-多设备同步Android-WearOS_2026-09-02.md`（UI 仓 Android/Wear OS）
- **下游**：
  - `~/Desktop/项目工作台/任务看板-Gina.md`（CI/CD 进度段）
  - gina-arch 评审记录（待补）
  - 老板 secrets 配置 checklist（GitHub Settings）
- **并行**：
  - worker B 干监控（prometheus + grafana + alertmanager）
  - worker B 干外部文档（用户手册 + API 文档）

---

*ADR 维护：gina-platform worker → gina-arch 评审 → 老板拍板。Status: proposed → ready for review → accepted。*
