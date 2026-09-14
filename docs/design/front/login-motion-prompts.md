# 登录动效素材生成记录

2026-09-13。使用内置 GPT Image 工具生成；该接口不提供模型版本参数，不能指定或确认用户提到的 2.5。未使用 CLI 或额外图像生成服务。

参考图为[原登录配图](../../../packages/web/src/assets/brand/login-execution.webp)。最终资源为[底图](../../../packages/web/src/assets/brand/login-motion-base.webp)（30,060 字节）和[分层素材](../../../packages/web/src/assets/brand/login-motion-parts.webp)（36,514 字节），均为 1024 × 1536。生成 PNG 经 cwebp 转换，质量分别为 86 / 90；页面通过 SVG 轮廓裁切素材白底，得到独立节点和面板。

## 底图提示词

```text
Use case: precise-object-edit. Asset type: background plate for a layered animated login illustration. Edit the supplied image, preserving its 1024 x 1536 portrait canvas, exact orthographic isometric camera, scale, pale cool blue background, gentle studio lighting, ceramic platform, and large upright central browser window. REMOVE the five circular blue/purple control pucks sitting along the blue track, and REMOVE the three small report/browser cards standing in front of the platform. Reconstruct the continuous smooth blue cable/track previously obscured by each puck, preserving the same path from the lower-left foreground near (158, 803), through (360, 855), (570, 802), (787, 720), to the upper-right near (914, 615). Keep the large central browser window, ceramic platform, and pale background otherwise exactly as they are. Remove any small gray connector lines attached only to the three removed front cards. This is a clean static BACKGROUND PLATE; moving pucks and front cards will be layered on top later. No text, no labels, no additional objects, no new logos, no decorative particles, no user interface outside the existing large browser window. Maintain all original colors and shadows of retained objects. Return one full-bleed 1024 x 1536 image, with no border.
```

## 分层素材提示词

第一次要求透明背景，实际结果为带棋盘格的 RGB 图，未作为正式资源使用：

```text
Use case: background-extraction. Asset type: transparent foreground plate for a layered web animation. From the supplied 1024 x 1536 portrait image, retain ONLY the five circular blue/purple control pucks and the three small front report cards, with their own localized soft shadows. Remove EVERYTHING else to actual transparent alpha: remove pale blue backdrop, white ceramic platform, all blue and gray connecting cables, and the big upright central browser. Crucially keep every retained object at exactly its original location, size, camera angle, perspective, color, and appearance within the unchanged 1024 x 1536 canvas. Five pucks: blue cursor near (158, 815), purple sparkle near (360, 865), blue input near (572, 813), purple sparkle near (787, 733), blue check near (914, 624). Three front cards: form card spanning approximately x=324..529,y=944..1110; data card x=567..745,y=875..1049; green-check card x=772..927,y=790..975. Preserve their original front-facing isometric appearance and understated white/blue materials. Do NOT arrange them into a new grid, do NOT recenter them, do NOT enlarge anything, do NOT connect the objects. The empty top half and every space between separate objects must be fully transparent, not white and not a checkerboard texture. Output one genuine RGBA transparent PNG 1024 x 1536. No labels, text, border, captions, or extra objects.
```

第二次以第一张分层图为输入，生成可供 SVG 裁切的白底素材：

```text
Use case: precise-object-edit. Edit this foreground sprite plate. The gray checkerboard is incorrectly baked into the image. Replace the entire checkerboard background with perfectly flat solid pure white (#FFFFFF). Do not simulate transparency, do not draw any checkerboard. Keep all FIVE circular blue/purple pucks and all THREE small report cards exactly at their current positions, dimensions, camera angles, colors, and forms. Keep the 1024 x 1536 portrait canvas unchanged. Remove all drop shadows outside the silhouettes so each object has a clean sharp edge against white; keep all internal 3D shading, white faces and blue/purple sides. No new objects, no connecting cables, no platform, no text. This source will be clipped into independently animated transparent shapes with SVG; a clean flat white matte is required for reliable edge masking and small file size.
```

动效代码：[LoginIllustration](../../../packages/web/src/features/auth/login-illustration.tsx)。轮廓、节点位置及轨道路径均使用素材原始坐标；改变图片构图后须一起调整，不能换图后沿用旧轮廓。
