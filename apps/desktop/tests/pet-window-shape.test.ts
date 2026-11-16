import assert from "node:assert/strict";

import { calculatePetInteractiveShape, compactComposerGeometry, getEffectiveBubbleScale, getPetWindowOverlayLift, getPetWindowPinnedLift, getPetWindowSpriteBottomInset, getPetWindowTokenDockLift, isRectangleContained, petTokenDockHeight, petWindowHitPadding } from "../src/pet-window-shape.js";
import { defaultPetWindowSize } from "../src/display.js";
import { calculateChatPanelBottom, defaultPetChatPanelLayout, expandedPetWindowSize } from "../src/default-pet-chat-geometry.js";

assert.equal(getPetWindowPinnedLift(false, 1.25), 0);
assert.equal(getPetWindowPinnedLift(true, 1.25), 35);
assert.equal(getPetWindowSpriteBottomInset(true, 1.25), 63);

// --- Collapsed Pet Interactive Shape ---

{
  const shapeInfo = calculatePetInteractiveShape({
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 3,
    hasBubble: false,
    isExpanded: false,
  });

  assert.equal(shapeInfo.shape.length, 1);
  assert.equal(shapeInfo.chatPanel, undefined);
  assert.ok(shapeInfo.petHitbox.width > 0);
  assert.ok(shapeInfo.petHitbox.height > 0);
  assert.ok(isRectangleContained(shapeInfo.companionLauncher, shapeInfo.petHitbox));
}

// --- Collapsed Pet with Bubble ---

{
  const shapeWithBubble = calculatePetInteractiveShape({
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 3,
    hasBubble: true,
    isExpanded: false,
  });

  assert.equal(shapeWithBubble.shape.length, 2);
  assert.equal(shapeWithBubble.chatPanel, undefined);
}

// --- Expanded Pet Interactive Shape (with In-Pet Attached Chat Panel) ---

{
  const expandedShapeInfo = calculatePetInteractiveShape({
    windowWidth: expandedPetWindowSize.width,
    windowHeight: expandedPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 3,
    hasBubble: false,
    isExpanded: true,
    panelWidth: defaultPetChatPanelLayout.width,
    panelHeight: defaultPetChatPanelLayout.height,
    panelTop: defaultPetChatPanelLayout.top,
  });

  // Should include both pet hitbox and chat panel
  assert.equal(expandedShapeInfo.shape.length, 2);
  assert.notEqual(expandedShapeInfo.chatPanel, undefined);
  assert.equal(expandedShapeInfo.chatPanel?.width, defaultPetChatPanelLayout.width);
  assert.equal(expandedShapeInfo.chatPanel?.height, defaultPetChatPanelLayout.height);
  assert.equal(expandedShapeInfo.chatPanel?.y, defaultPetChatPanelLayout.top);

  // Chat panel should be centered in the expanded window
  const expectedPanelX = Math.round((expandedPetWindowSize.width - defaultPetChatPanelLayout.width) / 2);
  assert.equal(expandedShapeInfo.chatPanel?.x, expectedPanelX);

  // Pet hitbox remains anchored at the bottom
  assert.ok(expandedShapeInfo.petHitbox.y > (expandedShapeInfo.chatPanel?.y ?? 0));
}

// --- Expanded Pet Interactive Shape (Bottom-Anchored Upward Growth) ---

{
  const scaledHeight = 32 * 3; // 96px
  const petBottom = 22;
  const expectedPanelBottom = calculateChatPanelBottom(scaledHeight, petBottom, defaultPetChatPanelLayout.gap);

  for (const panelHeight of [defaultPetChatPanelLayout.minHeight, 350, defaultPetChatPanelLayout.maxHeight]) {
    const shapeInfo = calculatePetInteractiveShape({
      windowWidth: expandedPetWindowSize.width,
      windowHeight: expandedPetWindowSize.height,
      spriteWidth: 32,
      spriteHeight: 32,
      scale: 3,
      hasBubble: true, // Should be suppressed when isExpanded: true
      isExpanded: true,
      panelWidth: defaultPetChatPanelLayout.width,
      panelHeight,
    });

    assert.equal(shapeInfo.shape.length, 2, "shape must contain pet hitbox and chat panel only (no bubble)");
    assert.notEqual(shapeInfo.chatPanel, undefined);
    assert.equal(shapeInfo.chatPanel?.width, defaultPetChatPanelLayout.width);
    assert.equal(shapeInfo.chatPanel?.height, panelHeight);

    // Invariant: The panel bottom edge is anchored exactly above the pet sprite
    assert.equal(shapeInfo.chatPanel!.y + shapeInfo.chatPanel!.height, expandedPetWindowSize.height - expectedPanelBottom);

    // Gap between top of pet sprite and bottom of chat panel is exactly 10px
    const petSpriteTop = expandedPetWindowSize.height - petBottom - scaledHeight;
    const panelBottomEdge = shapeInfo.chatPanel!.y + shapeInfo.chatPanel!.height;
    assert.equal(petSpriteTop - panelBottomEdge, defaultPetChatPanelLayout.gap);
  }
}

// --- Compact composer input shape ---

{
  const compactShapeInfo = calculatePetInteractiveShape({
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 3,
    hasBubble: false,
    isExpanded: false,
    isCompactOpen: true,
  });

  assert.equal(compactShapeInfo.shape.length, 2, "open compact chat adds a second input region");
  assert.notEqual(compactShapeInfo.compactComposer, undefined);
  const composer = compactShapeInfo.compactComposer!;
  assert.equal(composer.width, compactComposerGeometry.maxWidth);
  assert.equal(composer.height, compactComposerGeometry.maxHeight);
  const expectedComposerY = defaultPetWindowSize.height - Math.ceil(22 + 32 * 3 + compactComposerGeometry.bottomGap) - compactComposerGeometry.maxHeight;
  assert.equal(composer.y, expectedComposerY, "the input mask follows the composer's absolute bottom anchor");

  const contentX = composer.x + compactComposerGeometry.borderWidth;
  const contentWidth = composer.width - compactComposerGeometry.borderWidth * 2;
  const header = {
    x: contentX,
    y: composer.y + compactComposerGeometry.borderWidth,
    width: contentWidth,
    height: compactComposerGeometry.headerHeight,
  };
  const error = {
    x: contentX,
    y: header.y + header.height + compactComposerGeometry.gap,
    width: contentWidth,
    height: compactComposerGeometry.errorMaxHeight,
  };
  const form = {
    x: contentX,
    y: error.y + error.height + compactComposerGeometry.gap,
    width: contentWidth,
    height: compactComposerGeometry.textareaMaxHeight,
  };
  const textarea = { ...form, width: form.width - compactComposerGeometry.controlHeight - 5 };
  const controls = {
    x: textarea.x + textarea.width + 5,
    y: form.y + form.height - compactComposerGeometry.controlHeight,
    width: compactComposerGeometry.controlHeight,
    height: compactComposerGeometry.controlHeight,
  };

  for (const [name, part] of Object.entries({ header, error, textarea, controls })) {
    assert.ok(isRectangleContained(part, composer), `${name} must remain clickable inside the compact shape`);
  }
}

// --- Collapsed Pet with Pinned HUD ---

{
  const shapeWithPinned = calculatePetInteractiveShape({
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 1,
    hasBubble: false,
    hasPinned: true,
    hudScale: 1.4,
    isExpanded: false,
  });

  assert.equal(shapeWithPinned.shape.length, 2, "pinned HUD adds an interactive HUD region");
  const hudRect = shapeWithPinned.shape[1];
  assert.ok(hudRect.width > 0 && hudRect.width <= defaultPetWindowSize.width);
  assert.ok(hudRect.height > 0);
  assert.equal(hudRect.y + hudRect.height, defaultPetWindowSize.height);
}

// A persistent token dock must remain visible below the CPU HUD, while the
// pet, gaze anchor, composer and speech-bubble mask all move by the same lift.
for (const hudScale of [0.85, 2]) {
  const options = {
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 1,
    hudScale,
    hasPinned: true,
    hasBubble: true,
    isCompactOpen: true,
  };
  const withoutDock = calculatePetInteractiveShape(options);
  const withDock = calculatePetInteractiveShape({ ...options, hasTokenDock: true });
  const lift = getPetWindowTokenDockLift(true, hudScale);
  assert.equal(withDock.petHitbox.y, withoutDock.petHitbox.y - lift);
  assert.equal(withDock.compactComposer!.y, withoutDock.compactComposer!.y - lift);
  assert.equal(
    getPetWindowSpriteBottomInset(true, hudScale, true),
    getPetWindowSpriteBottomInset(true, hudScale) + lift,
    "gaze anchor uses the same vertical movement as the pet",
  );

  const dockWidth = Math.min(defaultPetWindowSize.width - 16, Math.ceil(188 * hudScale));
  const dockHeight = Math.ceil(petTokenDockHeight * hudScale);
  const visibleDock = {
    x: Math.round((defaultPetWindowSize.width - dockWidth) / 2),
    y: defaultPetWindowSize.height - 6 - dockHeight,
    width: dockWidth,
    height: dockHeight,
  };
  assert.ok(withDock.shape.some((rectangle) => isRectangleContained(visibleDock, rectangle)), "Linux mask includes the visible token dock");
  const oldHud = withoutDock.shape[1];
  const movedHud = withDock.shape[1];
  assert.equal(movedHud.y, oldHud.y - lift, "CPU HUD moves above the token dock");
  assert.ok(movedHud.y + movedHud.height <= visibleDock.y, "CPU and token regions do not overlap");

  const bubbleWithoutDock = calculatePetInteractiveShape({ ...options, isCompactOpen: false }).shape.at(-1)!;
  const bubbleWithDock = calculatePetInteractiveShape({ ...options, isCompactOpen: false, hasTokenDock: true }).shape.at(-1)!;
  assert.equal(
    bubbleWithDock.y + bubbleWithDock.height,
    bubbleWithoutDock.y + bubbleWithoutDock.height - lift,
    "speech bubble mask follows the same raised anchor",
  );
}

// Opening full chat keeps the dock visible and shifts the attached panel with
// the pet rather than letting its lower edge collide with the new status row.
{
  const options = {
    windowWidth: expandedPetWindowSize.width,
    windowHeight: expandedPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 1,
    hudScale: 1.4,
    hasBubble: false,
    isExpanded: true,
  };
  const plain = calculatePetInteractiveShape(options);
  const docked = calculatePetInteractiveShape({ ...options, hasTokenDock: true });
  const lift = getPetWindowOverlayLift(false, options.hudScale, true);
  assert.equal(docked.chatPanel!.y, plain.chatPanel!.y - lift);
  assert.equal(docked.petHitbox.y, plain.petHitbox.y - lift);
  assert.equal(docked.shape.length, plain.shape.length + 1, "expanded input mask still includes the visible dock");
}

// A lone status strip uses the hitbox's existing foot padding: the visible
// sprite frame stays about six pixels above it instead of floating far away.
for (const hudScale of [0.85, 1.1, 2]) {
  const options = {
    windowWidth: defaultPetWindowSize.width,
    windowHeight: defaultPetWindowSize.height,
    spriteWidth: 32,
    spriteHeight: 32,
    scale: 1,
    hudScale,
    hasBubble: false,
  };
  const plain = calculatePetInteractiveShape(options);
  const docked = calculatePetInteractiveShape({ ...options, hasTokenDock: true });
  const lift = getPetWindowOverlayLift(false, hudScale, true);
  assert.equal(docked.petHitbox.y, plain.petHitbox.y - lift);
  const spriteBottom = docked.petHitbox.y + docked.petHitbox.height - petWindowHitPadding;
  const dockTop = defaultPetWindowSize.height - 6 - petTokenDockHeight * hudScale;
  assert.ok(dockTop - spriteBottom >= 6 && dockTop - spriteBottom < 7, "single strip keeps a compact six-pixel foot gap");
  assert.equal(getPetWindowSpriteBottomInset(false, hudScale, true), petWindowHitPadding + lift);
  assert.equal(getPetWindowOverlayLift(false, hudScale, false), 0, "pets without either HUD keep their original position");
  assert.equal(
    getPetWindowOverlayLift(true, hudScale, true),
    getPetWindowPinnedLift(true, hudScale) + getPetWindowTokenDockLift(true, hudScale),
    "CPU and token combination keeps its established spacing",
  );
}

// --- Speech bubble scale ---
// Contract: a larger bubble never spills outside the pet window, never ends up
// smaller than the default, and the Linux input shape grows with it so the
// bubble stays clickable.
{
  const { width, height } = defaultPetWindowSize;
  assert.equal(getEffectiveBubbleScale(0.85, width, height, 200), 0.85, "smaller sizes are honored as-is");
  assert.equal(getEffectiveBubbleScale(1.2, width, height, 186), 1.2, "room above a medium pet allows Large");
  assert.equal(getEffectiveBubbleScale(1.4, width, height, 240), 1.15, "a taller pet caps Huge to what fits above it");
  assert.equal(getEffectiveBubbleScale(1.4, width, height, 400), 1, "no room keeps the default size");

  const shapeFor = (bubbleScale: number) => calculatePetInteractiveShape({
    windowWidth: width,
    windowHeight: height,
    spriteWidth: 192,
    spriteHeight: 208,
    scale: 0.75,
    hasBubble: true,
    bubbleScale,
  }).shape.at(-1)!;
  const normal = shapeFor(1);
  const large = shapeFor(1.2);
  assert.ok(large.height > normal.height, "a larger bubble gets a larger input region");
  assert.ok(large.y >= 0, "the bubble region stays inside the window");
  assert.equal(large.y + large.height, normal.y + normal.height, "the bubble grows upward from the same anchor");

  // Media previews use a taller box (`.bubble.has-media`, up to 224px), so
  // Huge must be capped harder for them or the preview is cut off.
  const mediaBubbleHeight = 224;
  const bubbleBottom = 186;
  const mediaScale = getEffectiveBubbleScale(1.4, width, height, bubbleBottom, true);
  assert.ok(mediaScale * mediaBubbleHeight <= height - bubbleBottom, "an enlarged media bubble still fits above the pet");
  const mediaShape = calculatePetInteractiveShape({
    windowWidth: width,
    windowHeight: height,
    spriteWidth: 192,
    spriteHeight: 208,
    scale: 0.75,
    hasBubble: true,
    bubbleScale: 1,
    bubbleHasMedia: true,
  }).shape.at(-1)!;
  assert.ok(mediaShape.height >= mediaBubbleHeight, "the whole media bubble stays clickable");
}

console.log("pet-window-shape tests passed.");
