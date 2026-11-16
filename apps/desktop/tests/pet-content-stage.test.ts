import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { calculateMotionLayout, motionLayoutCssVariables } from "../src/pet-motion-layout.js";
const require = createRequire(import.meta.url);
const root = process.env.OPENPETS_DESKTOP_ROOT ?? process.cwd();
const { createPetContentStageController } = require(join(root, "src/pet-content-stage.cjs"));
type Stage = { motion?: boolean; name?: string; replaceWith(next: Stage): void };
function fixture(initialMotion = false) {
  const commits: Array<{ token: string; presentationId: string | null; outfitId: string | null }> = [];
  const errors: unknown[] = [];
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null; src: string; decode(): Promise<void> }> = [];
  const sprite = { matches: () => true };
  const hostStyle = { textContent: "old-style", setAttribute() {} };
  let applied = 0;
  let motion = initialMotion;
  let currentStage: Stage = { name: "old", replaceWith(next: Stage) { motion = next.motion ?? false; currentStage = next; } };
  const document = {
    documentElement: { dataset: { flipX: "false", paused: "false" } as Record<string, string>, lang: "en" },
    head: { querySelector: () => hostStyle },
    querySelector(selector: string) {
      if (selector === ".stage") return currentStage;
      if (selector === ".pet-shell .sprite[data-motion-body]") return motion ? {} : null;
      return null;
    },
    importNode(candidate: { motion: boolean; name: string }) {
      const next = { ...candidate, replaceWith: currentStage.replaceWith, querySelector(selector: string) {
        if (selector === ".pet-shell .sprite[data-motion-body]") return next.motion ? sprite : null;
        if (selector === ".pet-shell .installed-sprite, .pet-shell .sprite") return next.motion ? null : sprite;
        return null;
      } };
      return next;
    },
  };
  const controller = createPetContentStageController(document, {
    parseDocument(html: string) { return { documentElement: { lang: "en", dataset: { paused: "true", flipX: "true" } }, head: { querySelectorAll: () => [{ textContent: `css-${html}` }] }, querySelector: () => ({ motion: html.startsWith("motion"), name: html }) }; },
    createStyleSheet() { return { replaceSync() {}, cssRules: [{ selectorText: ".sprite", style: { backgroundImage: 'url("file:///pet.webp")' } }] }; },
    createImage() { const image = { onload: null, onerror: null, src: "", decode: () => Promise.resolve() }; images.push(image); return image; },
    onCommit: (payload: typeof commits[number]) => commits.push(payload), onError: (error: unknown) => errors.push(error),
  });
  const appearance = (id: string) => ({ assets: { snapshotId: id }, presentationId: id, outfitId: "default" });
  if (initialMotion) controller.motionPresented(appearance("old-snapshot"));
  function replace(html: string, token: string, id: string | null = null) { controller.replaceStage({ documentHtml: html, contentCommitToken: token, motionSnapshotId: id, motionPresentationId: id, motionOutfitId: id ? "default" : null }, () => { applied += 1; }); }
  return { controller, replace, appearance, commits, errors, images, getApplied: () => applied, getMotion: () => motion, getStage: () => currentStage.name, hostStyle, document };
}

test("visible Motion HUD commits immediately without waiting for another frame", () => {
  const f = fixture(true); f.replace("motion-hud", "hud", "old-snapshot");
  assert.equal(f.getApplied(), 1); assert.equal(f.getStage(), "motion-hud");
  assert.equal(f.hostStyle.textContent, "css-motion-hud"); assert.equal(f.document.documentElement.dataset.flipX, "true");
  assert.deepEqual(f.commits, [{ token: "hud", presentationId: "old-snapshot", outfitId: "default" }]);
});

test("replacement retains old stage, dimensions and attributes until matching frame", () => {
  const f = fixture(true); f.replace("motion-new-geometry", "new", "new-snapshot");
  assert.equal(f.getStage(), "old"); assert.equal(f.hostStyle.textContent, "old-style");
  assert.equal(f.document.documentElement.dataset.flipX, "false"); assert.deepEqual(f.commits, []);
  assert.equal(f.controller.prepareMotionPresentation(f.appearance("old-snapshot")), true);
  f.controller.motionPresented(f.appearance("old-snapshot")); assert.equal(f.getStage(), "old"); assert.deepEqual(f.commits, []);
  assert.equal(f.controller.prepareMotionPresentation(f.appearance("new-snapshot")), true);
  assert.equal(f.getStage(), "motion-new-geometry"); assert.deepEqual(f.commits, []);
  f.controller.motionPresented(f.appearance("new-snapshot")); assert.deepEqual(f.commits, [{ token: "new", presentationId: "new-snapshot", outfitId: "default" }]);
});

test("failed Classic artwork leaves existing Motion body and styles intact", () => {
  const f = fixture(true); f.replace("classic-broken", "token"); f.images[0]!.onerror!();
  assert.equal(f.getMotion(), true); assert.equal(f.hostStyle.textContent, "old-style"); assert.equal(f.getApplied(), 0); assert.deepEqual(f.commits, []); assert.equal(f.errors.length, 1);
});

test("superseded Classic decode cannot apply or commit", async () => {
  const f = fixture(true); f.replace("classic-old", "old"); const stale = f.images[0]!.onload!; f.replace("classic-new", "new"); stale(); await Promise.resolve();
  assert.equal(f.getMotion(), true); f.images[1]!.onload!(); await Promise.resolve();
  assert.equal(f.getMotion(), false); assert.equal(f.getApplied(), 1); assert.deepEqual(f.commits, [{ token: "new", presentationId: null, outfitId: null }]);
});

test("Classic remains visible until a new Motion frame and stale candidates never commit", () => {
  const f = fixture(false); f.replace("motion-old", "old", "one"); f.replace("motion-new", "new", "two");
  assert.equal(f.getStage(), "old"); assert.equal(f.controller.prepareMotionPresentation(f.appearance("one")), false); assert.deepEqual(f.commits, []);
  assert.equal(f.controller.prepareMotionPresentation(f.appearance("two")), true); assert.equal(f.getStage(), "motion-new");
  assert.deepEqual(f.commits, []); f.controller.motionPresented(f.appearance("two")); assert.deepEqual(f.commits, [{ token: "new", presentationId: "two", outfitId: "default" }]);
  f.controller.dispose();
});

test("different outfits sharing one snapshot commit only their matching presentation", () => {
  const f = fixture(false);
  const a = { assets: { snapshotId: "shared" }, presentationId: "a", outfitId: "default" };
  const b = { assets: { snapshotId: "shared" }, presentationId: "b", outfitId: "coat" };
  f.controller.replaceStage({ documentHtml: "motion-a", contentCommitToken: "a-token", motionSnapshotId: "shared", motionPresentationId: "a", motionOutfitId: "default" }, () => {});
  assert.equal(f.controller.prepareMotionPresentation(a), true);
  f.controller.motionPresented(a);
  f.controller.replaceStage({ documentHtml: "motion-b", contentCommitToken: "b-token", motionSnapshotId: "shared", motionPresentationId: "b", motionOutfitId: "coat" }, () => {});
  assert.equal(f.getStage(), "motion-a");
  assert.equal(f.controller.prepareMotionPresentation(a), true);
  f.controller.motionPresented(a);
  assert.equal(f.getStage(), "motion-a");
  assert.equal(f.controller.prepareMotionPresentation(b), true);
  f.controller.motionPresented(b);
  assert.equal(f.getStage(), "motion-b");
  assert.deepEqual(f.commits, [{ token: "a-token", presentationId: "a", outfitId: "default" }, { token: "b-token", presentationId: "b", outfitId: "coat" }]);
  f.controller.dispose();
});

test("a remembered scale is fitted to candidate geometry before presentation", () => {
  const layoutInput = { geometry: { width: 4096, height: 4096, pixelsPerUnit: 1, footAnchor: { x: 512, y: 4096 } }, requestedScale: 0.75, windowWidth: 340, windowHeight: 420, hitboxBottomInset: 0, hitPadding: 8, flipped: false };
  const variables: Record<string, string> = {};
  const stage = { style: { setProperty(name: string, value: string) { variables[name] = value; } }, querySelector: () => sprite, replaceWith() {} };
  const sprite = { style: { transform: "" }, hasAttribute: () => true, getAttribute: () => JSON.stringify(layoutInput), closest: () => stage };
  let current: typeof stage | null = null;
  const document = {
    documentElement: { dataset: {}, lang: "en" },
    head: { querySelector: () => ({ textContent: "", setAttribute() {} }) },
    body: { firstChild: null, insertBefore(next: typeof stage) { current = next; } },
    querySelector(selector: string) { return selector === ".stage" ? current : current ? sprite : null; },
    importNode: () => stage,
  };
  let applied = false;
  const controller = createPetContentStageController(document, {
    parseDocument: () => ({ documentElement: { dataset: {}, lang: "en" }, head: { querySelectorAll: () => [] }, querySelector: () => stage }),
  });
  controller.setScaleOverride(2);
  controller.replaceStage({ documentHtml: "motion", contentCommitToken: "one", motionSnapshotId: "one", motionPresentationId: "one", motionOutfitId: "default" }, () => { applied = true; });
  assert.equal(applied, false);
  assert.equal(controller.prepareMotionPresentation({ assets: { snapshotId: "one" }, presentationId: "one", outfitId: "default" }), true);
  assert.equal(applied, true);
  assert.deepEqual(variables, motionLayoutCssVariables(calculateMotionLayout({ ...layoutInput, requestedScale: 2 })));
  assert.equal(sprite.style.transform, "");
  controller.dispose();
});

class ConnectedNode {
  readonly childNodes: ConnectedNode[] = [];
  parentNode: ConnectedNode | null = null;
  disconnections = 0;
  readonly style = { transform: "" };
  private readonly values = new Map<string, string>();

  constructor(readonly kind: string, readonly label = "") {}

  get attributes() {
    return [...this.values].map(([name, value]) => ({ name, value }));
  }

  get connected(): boolean {
    return this.kind === "body" || this.parentNode?.connected === true;
  }

  hasAttribute(name: string): boolean { return this.values.has(name); }
  getAttribute(name: string): string | null { return this.values.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.values.set(name, value); }
  removeAttribute(name: string): void { this.values.delete(name); }
  matches(): boolean { return this.kind === "sprite"; }

  querySelector(selector: string): ConnectedNode | null {
    if (selector.includes("data-motion-body")) return null;
    const kind = selector === ".stage" ? "stage"
      : selector === ".pet-hitbox" ? "hitbox"
      : selector === ".pet-shell" ? "shell" : "sprite";
    for (const child of this.childNodes) {
      if (child.kind === kind) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  insertBefore(node: ConnectedNode, reference: ConnectedNode | null): void {
    node.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
  }

  remove(): void {
    if (this.connected) this.recordDisconnection();
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  replaceWith(next: ConnectedNode): void {
    assert.ok(this.parentNode);
    this.parentNode.insertBefore(next, this);
    this.remove();
  }

  private recordDisconnection(): void {
    this.disconnections += 1;
    for (const child of this.childNodes) child.recordDisconnection();
  }
}

function classicPresentationFixture() {
  const body = new ConnectedNode("body");
  const initialStage = makeStage("initial");
  body.insertBefore(initialStage, null);
  const rootDataset: Record<string, string> = { classicRenderIdentity: "initial", reactionState: "idle" };
  let styleText = "style:file:///initial.webp";
  let styleWrites = 0;
  let replacements = 0;
  const hostStyle = {
    get textContent() { return styleText; },
    set textContent(value: string) { styleText = value; styleWrites += 1; },
    setAttribute() {},
  };
  const images: Array<{ onload: (() => Promise<void>) | null; onerror: (() => void) | null; src: string; decode: () => Promise<void> }> = [];
  const documents = new Map<string, unknown>();
  const commits: Array<{ token: string }> = [];
  const errors: unknown[] = [];
  const document = {
    body,
    documentElement: { dataset: rootDataset, lang: "en" },
    head: { querySelector: () => hostStyle },
    querySelector: (selector: string) => body.querySelector(selector),
    importNode: (node: ConnectedNode) => node,
  };
  const controller = createPetContentStageController(document, {
    parseDocument: (html: string) => documents.get(html),
    createStyleSheet: () => ({
      cssRules: [] as unknown[],
      replaceSync(styles: string) {
        this.cssRules = [{ selectorText: ".sprite", style: { backgroundImage: `url("${styles.slice("style:".length)}")` } }];
      },
    }),
    createImage: () => {
      const image = { onload: null, onerror: null, src: "", decode: () => Promise.resolve() };
      images.push(image);
      return image;
    },
    onSpriteReplaced: () => { replacements += 1; },
    onCommit: (payload: { token: string }) => commits.push(payload),
    onError: (error: unknown) => errors.push(error),
  });

  function makeStage(label: string): ConnectedNode {
    const stage = new ConnectedNode("stage", label);
    const hitbox = new ConnectedNode("hitbox");
    const shell = new ConnectedNode("shell");
    const sprite = new ConnectedNode("sprite");
    shell.insertBefore(sprite, null);
    hitbox.insertBefore(new ConnectedNode("controls", label), null);
    hitbox.insertBefore(shell, null);
    stage.insertBefore(new ConnectedNode("bubble", label), null);
    stage.insertBefore(hitbox, null);
    return stage;
  }

  function replace(identity: string, label: string, reaction = "idle", image = "file:///initial.webp"): void {
    documents.set(label, {
      documentElement: { lang: "en", dataset: { classicRenderIdentity: identity, reactionState: reaction } },
      head: { querySelectorAll: () => [{ textContent: `style:${image}` }] },
      querySelector: () => makeStage(label),
    });
    controller.replaceStage({ documentHtml: label, contentCommitToken: label, classicRenderIdentity: identity }, () => {});
  }
  return {
    controller, replace, images, commits, errors, initialStage, rootDataset,
    getStage: () => body.querySelector(".stage")!,
    getStyleWrites: () => styleWrites,
    getReplacements: () => replacements,
  };
}

test("Classic reaction and presentation refreshes keep sprite ancestors connected and styles untouched", () => {
  const f = classicPresentationFixture();
  const stage = f.getStage();
  const hitbox = stage.querySelector(".pet-hitbox")!;
  const shell = hitbox.querySelector(".pet-shell")!;
  const sprite = shell.querySelector(".sprite")!;
  f.replace("initial", "working-bubble", "review");
  f.replace("initial", "new-hud", "review");
  f.replace("initial", "idle", "idle");
  assert.equal(f.images.length, 0, "already visible artwork needs no decode");
  assert.equal(f.getStage(), stage);
  assert.equal(stage.querySelector(".pet-hitbox"), hitbox);
  assert.equal(hitbox.querySelector(".pet-shell"), shell);
  assert.equal(shell.querySelector(".sprite"), sprite);
  for (const node of [stage, hitbox, shell, sprite]) {
    assert.equal(node.connected, true);
    assert.equal(node.disconnections, 0, "sprite and ancestors must never detach and restart CSS animation");
  }
  assert.equal(stage.childNodes[0]!.label, "idle");
  assert.equal(hitbox.childNodes[0]!.label, "idle");
  assert.equal(f.rootDataset.reactionState, "idle");
  assert.equal(f.getStyleWrites(), 0);
  assert.equal(f.getReplacements(), 0);
  assert.deepEqual(f.commits.map((item) => item.token), ["working-bubble", "new-hud", "idle"]);
  f.controller.dispose();
});

test("a new Classic revision at the same image URL waits for decode and commits only its latest presentation", async () => {
  const f = classicPresentationFixture();
  f.replace("new-revision", "first-bubble");
  f.replace("new-revision", "latest-bubble", "review");
  assert.equal(f.images.length, 1, "same pending revision shares one decode");
  assert.equal(f.getStage(), f.initialStage);
  assert.equal(f.getReplacements(), 0);
  await f.images[0]!.onload!();
  assert.notEqual(f.getStage(), f.initialStage);
  assert.equal(f.getStage().label, "latest-bubble");
  assert.equal(f.rootDataset.classicRenderIdentity, "new-revision");
  assert.equal(f.rootDataset.reactionState, "review");
  assert.equal(f.getReplacements(), 1);
  assert.deepEqual(f.commits.map((item) => item.token), ["latest-bubble"]);
  f.controller.dispose();
});

test("failed and superseded Classic artwork cannot replace the current connected sprite", async () => {
  const f = classicPresentationFixture();
  f.replace("broken", "broken", "idle", "file:///broken.webp");
  f.images[0]!.onerror!();
  assert.equal(f.errors.length, 1);
  assert.equal(f.getStage(), f.initialStage);
  f.replace("other", "other", "idle", "file:///other.webp");
  const stale = f.images[1]!.onload!;
  f.replace("initial", "back-to-current", "waiting");
  await stale();
  assert.equal(f.images.length, 2);
  assert.equal(f.getStage(), f.initialStage);
  assert.equal(f.initialStage.disconnections, 0);
  assert.equal(f.rootDataset.reactionState, "waiting");
  assert.equal(f.getReplacements(), 0);
  assert.deepEqual(f.commits.map((item) => item.token), ["back-to-current"]);
  f.controller.dispose();
});
