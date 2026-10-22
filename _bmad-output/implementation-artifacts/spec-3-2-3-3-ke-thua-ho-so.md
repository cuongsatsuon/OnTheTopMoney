---
title: 'Story 3.2 + 3.3 — Kế thừa hồ sơ, dùng hồ sơ riêng, giữ cấu hình khi đổi nhóm'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-1-ho-so-thuong-hieu.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 3.2 + 3.3 (PM duyệt); gộp vì cùng cơ chế kế thừa AD-8">

## Intent

**Problem:** Hồ sơ thương hiệu đã lưu theo (owner_type, owner_id) nhưng chưa có kế thừa Nhóm→Trang: chưa giải "trang dùng hồ sơ nào", chưa có "Dùng hồ sơ riêng", và khi đổi/xoá nhóm cấu hình trang có thể mồ côi. AD-8 yêu cầu giải kế thừa ở MỘT chỗ (`resolveEffective`) và phản ứng sự kiện chung cho mọi loại cấu hình (brand nay, AI ở Epic 5).

**Approach:** Thêm cờ `use_own_brand` trên trang + trạng thái `awaiting_group_default` (per page per kind); `profiles.resolveEffective(pageId, kind)` là hàm DUY NHẤT giải kế thừa → `{config, source{ownerType,ownerId,name}}` hoặc `CONFIG_MISSING`. Một "registry loại cấu hình" (brand đăng ký nay; AI đăng ký Epic 5) với ops copy/delete/exists. `profiles` nghe `page.group_changed` và `group.deleted`, áp các chuyển đổi idempotent (3.3). FE: nhãn kế thừa + công tắc "Dùng hồ sơ riêng" (bật/tắt chỉ áp khi Lưu, tắt thì hỏi lại).

## Boundaries & Constraints

**Always — Story 3.2 (4 AC):**
- `profiles.resolveEffective(pageId, kind)` là hàm DUY NHẤT giải kế thừa. `use_own_<kind>=true` → cấu hình của trang; else có nhóm & nhóm có cấu hình → cấu hình nhóm kèm `source{ownerType:group, ownerId, name}`; không có → `CONFIG_MISSING`.
- Bật "Dùng hồ sơ riêng" rồi **Lưu** → sao chép hồ sơ nhóm làm điểm xuất phát cho hồ sơ trang, `use_own_brand=true`. Bật công tắc mà CHƯA Lưu → server không đổi gì (chỉ state FE).
- Tắt "Dùng hồ sơ riêng" + xác nhận + Lưu → xoá hồ sơ riêng của trang, trang quay về hồ sơ nhóm (`use_own_brand=false`).
- Trang không nhóm & không hồ sơ → `resolveEffective` trả `CONFIG_MISSING`; FE yêu cầu tạo hồ sơ riêng cho trang.

**Always — Story 3.3 (3 AC, cùng cơ chế):**
- `profiles` nghe `page.group_changed` & `group.deleted`, xử lý CHUNG cho mọi loại cấu hình đã đăng ký (registry; nay chỉ brand). Handler **idempotent** khi sự kiện tới hai lần.
- Trang rời nhóm (kể cả do xoá nhóm) mà KHÔNG có cấu hình riêng → sao chép cấu hình nhóm cũ thành cấu hình riêng (`use_own_*=true`); cấu hình của nhóm đã xoá bị xoá sau đó.
- Trang vào nhóm đã có cấu hình loại đó → xoá cấu hình riêng của trang, `use_own_*=false`.
- Trang vào nhóm CHƯA có cấu hình loại đó → giữ cấu hình riêng, đánh dấu `awaiting_group_default`; khi cấu hình nhóm loại đó được lưu lần đầu → các trang đánh dấu chuyển về "Theo nhóm" (`use_own_*=false`, bỏ cờ).
- Mọi thay đổi trạng thái + sự kiện trong cùng transaction (AD-3). `publishEvent(tx,…)`.

**Never:** Không nhân bản luật kế thừa ngoài `resolveEffective`/registry. Không áp đổi khi chỉ bật công tắc (chưa Lưu). Không gọi AI. Không làm consumer (autoreply/composer/campaigns) — chỉ cung cấp resolveEffective + CONFIG_MISSING để epic sau dùng. Giữ `group.deleted`/`page.group_changed` payload như Story 2.5.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| resolve: trang dùng nhóm | use_own_brand=false, nhóm có hồ sơ | {config nhóm, source{group,name}} | |
| resolve: dùng riêng | use_own_brand=true | {config trang, source{page}} | |
| resolve: không nhóm/không hồ sơ | | CONFIG_MISSING | |
| bật riêng + Lưu | | copy hồ sơ nhóm→trang, use_own_brand=true | nhóm chưa có hồ sơ để copy → tạo trống hoặc CONFIG? (ghi chú) |
| bật công tắc chưa Lưu | | server không đổi | |
| tắt riêng + Lưu | | xoá hồ sơ trang, use_own_brand=false | |
| rời nhóm, không cấu hình riêng | page.group_changed {A,null} | copy cấu hình A→trang, use_own=true | |
| xoá nhóm | group.deleted | trang thành viên copy cấu hình cũ→riêng rồi xoá cấu hình nhóm | |
| vào nhóm đã có cấu hình | group_changed {null,B}, B có brand | xoá cấu hình riêng, use_own=false | |
| vào nhóm chưa có cấu hình | B chưa có brand | giữ riêng, awaiting_group_default=true | |
| nhóm B lưu brand lần đầu | | các trang awaiting của B → use_own=false, bỏ cờ | |
| sự kiện tới 2 lần | | idempotent (không nhân đôi/không hỏng) | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/pages/schema.ts` — thêm cờ `use_own_brand boolean default false` (và `awaiting_group_brand`/trạng thái awaiting per kind) trên pages, HOẶC bảng generic `page_config_state(page_id, kind, use_own, awaiting_group_default)` để mở rộng cho AI (Epic 5). Chọn theo AD-8 (AD-8 nói cờ trên trang `use_own_brand`/`use_own_autoreply`) — awaiting có thể bảng phụ. Ghi chú lựa chọn.
- `server/src/modules/profiles/service.ts`, `index.ts` — `resolveEffective(db, pageId, kind)`; `setUseOwn(pageId, kind, useOwn)` (copy/xoá hồ sơ trang theo AC); registry loại cấu hình `{ kind: { copy(tx, fromOwner, toOwner), remove(tx, owner), exists(tx, owner), onGroupProfileSaved(tx, groupId) } }` (brand đăng ký). `upsertProfile` nhóm → sau khi lưu, nếu là nhóm, chạy `onGroupProfileSaved` (chuyển trang awaiting về theo nhóm).
- `server/src/modules/profiles/events.ts` (MỚI) — consumer `page.group_changed`, `group.deleted`: với mỗi kind đã đăng ký áp chuyển đổi 3.3, idempotent. Đăng ký queue subscribe ở `queues.ts` + handler ở `worker/main.ts`.
- `packages/shared/src/` — `ConfigKind` enum (`brand`; `autoreply` để sau), `EffectiveConfig<T>`/`ConfigSource`, `CONFIG_MISSING` ErrorCode (kiểm đã có chưa — errors.ts), DTO cho resolveEffective + setUseOwn request.
- `server/src/app/brand-profiles.ts` (hoặc route profiles) — endpoint `GET /brand-profiles/effective/page/:id` (resolveEffective) + `PUT …/use-own` (bật/tắt riêng khi Lưu).
- `web/src/components/BrandProfileForm.tsx`, `web/src/screens/{PageDetail,GroupDetail}.tsx` — nhãn "Đang dùng hồ sơ của Nhóm …" (Component "Nhãn kế thừa"), công tắc "Dùng hồ sơ riêng" (tắt → hỏi lại), CONFIG_MISSING → mời tạo hồ sơ riêng; `web/src/lib/profiles.ts` hooks.
- UX: F1 b5, F1 Thất bại, "Kế thừa cấu hình", Component "Nhãn kế thừa".

## Tasks & Acceptance

**Execution:**
- [ ] BE: cờ use_own + awaiting state (+migration); `resolveEffective`, `setUseOwn`, registry loại cấu hình (brand), `onGroupProfileSaved`.
- [ ] BE: consumer `page.group_changed`/`group.deleted` (idempotent) áp 3.3; đăng ký queue + worker.
- [ ] shared: ConfigKind/EffectiveConfig/ConfigSource + CONFIG_MISSING; route effective + use-own.
- [ ] FE: nhãn kế thừa, công tắc Dùng hồ sơ riêng (áp khi Lưu, tắt hỏi lại), CONFIG_MISSING mời tạo.
- [ ] Test: server (resolveEffective mọi nhánh + CONFIG_MISSING; setUseOwn bật copy/tắt xoá; 3.3: rời nhóm→copy riêng, xoá nhóm→copy rồi xoá, vào nhóm có/chưa có cấu hình, awaiting→theo nhóm khi nhóm lưu, idempotent 2 lần); web (nhãn kế thừa, công tắc áp-khi-Lưu, tắt hỏi lại, CONFIG_MISSING).

**Acceptance Criteria:** 4 AC Story 3.2 + 3 AC Story 3.3 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| FE chưa nối inheritance (nhãn kế thừa, công tắc Dùng hồ sơ riêng, CONFIG_MISSING invite) vào API thật cho owner uuid | high | patch (nối BrandProfileForm/PageDetail) |
| events: group.deleted thiếu/không-mảng memberPageIds → for-of ném thay vì 'ignored' | medium | patch (guard Array.isArray) |
| events: page.group_changed thiếu toGroupId → undefined rơi nhánh join, query groupOwner(undefined) | medium | patch (toGroupId ?? null) |
| worker events.profiles: parseEventEnvelope ném ZodError → đốt retry, path 'ignored' bất khả | medium | patch (catch/log hoặc theo pattern events.ai) |
| setUseOwn(false) khi trang không nhóm → xoá hồ sơ duy nhất, CONFIG_MISSING | medium | patch (guard: không nhóm thì không cho tắt/no-op) |
| Trang có hồ sơ riêng chủ ý vào nhóm config-less → awaiting → bị xoá khi nhóm lưu | false | reject (đúng AC 3.3 case 3; gán vào nhóm = theo nhóm, 2.5 đã confirm khi gán) |
| copy logoPath → 2 owner cùng URL Cloudinary | low | defer (gắn với dọn orphan media #10) |
| comment schema nói "không đổi schema" nhưng CHECK hardcode brand | low | patch (sửa comment) |
| upsertProfile DbExecutor→Db | low | reject (caller route truyền Db; hoạt động) |
| consumer không phát event → FE không tự refresh sau group-change nền | low | defer (realtime hint) |
| thiếu index awaiting; label giả định "Nhóm"; effective không zod-parse ra | low | reject (quy mô/đã qua toBrandDto) |
