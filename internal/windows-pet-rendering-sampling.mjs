/** CDP-injected observation programs; no Electron or profile access on import. */
import { keyframeBackgroundPosition } from './windows-pet-rendering-core.mjs';

export const observationExpression = `(() => {
  const backgroundPositionOf = ${keyframeBackgroundPosition.toString()};
  const ids = globalThis.__openPetsNativeIdentities ??= {
    document: Math.random().toString(36).slice(2, 10), next: 0,
    objects: new WeakMap(), semanticEpoch: 0,
  };
  const identity = object => {
    if (!ids.objects.has(object)) ids.objects.set(object, ++ids.next);
    return ids.objects.get(object);
  };
  const root = document.documentElement;
  const sprite = document.querySelector('.pet-shell .installed-sprite, .pet-shell .sprite');
  const style = sprite && getComputedStyle(sprite);
  const rect = sprite && sprite.getBoundingClientRect();
  return {
    observedAt: performance.now(), documentTimeOrigin: performance.timeOrigin,
    documentIdentity: ids.document, semanticEpoch: ids.semanticEpoch, userAgent: navigator.userAgent,
    visibility: document.visibilityState, focused: document.hasFocus(),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    devicePixelRatio, readyState: document.readyState,
    spriteVersion: root.dataset.codexSpriteVersion,
    reaction: root.dataset.reactionState, motion: root.dataset.motionState,
    paused: root.dataset.paused, classicRest: root.dataset.classicRest || null,
    idleAnimation: root.dataset.idleAnimation || null,
    sprite: sprite ? { identity: identity(sprite), display: style.display, visibility: style.visibility,
      opacity: style.opacity, backgroundPosition: style.backgroundPosition,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      backgroundImagePresent: style.backgroundImage !== 'none' } : null,
    viewport: { width: innerWidth, height: innerHeight },
    animations: sprite ? sprite.getAnimations().map(animation => ({
      identity: identity(animation),
      name: animation.animationName || animation.id || 'unnamed',
      time: typeof animation.currentTime === 'number' ? animation.currentTime : null,
      startTime: typeof animation.startTime === 'number' ? animation.startTime : null,
      playbackRate: animation.playbackRate,
      state: animation.playState, pending: animation.pending,
      duration: animation.effect?.getComputedTiming().duration,
      changesBackgroundPosition: Boolean(animation.effect?.getKeyframes().some(frame => backgroundPositionOf(frame) !== null)),
    })) : [],
  };
})()`;

export const installCollectorExpression = `(() => {
  globalThis.__openPetsNativeCollector?.stop();
  const take = () => ${observationExpression};
  const collector = { samples: [take()], mutations: [], intervals: [], mutationEventsSeen: 0, stopped: false };
  globalThis.__openPetsNativeCollector = collector;
  const ids = globalThis.__openPetsNativeIdentities;
  const semantic = new Set(['data-reaction-state', 'data-motion-state', 'data-paused',
    'data-idle-animation', 'data-classic-rest']);
  const rootDiagnostics = new Set([...semantic, 'data-classic-render-identity',
    'data-codex-sprite-version', 'data-flip-x', 'data-codex-gaze-index']);
  const critical = '.stage, .pet-hitbox, .pet-shell, .sprite, .installed-sprite';
  const describe = node => node?.nodeType === 1
    ? { tag: node.tagName, classes: String(node.className || '').slice(0, 120) }
    : { tag: node?.nodeType === 3 ? '#text' : '#other' };
  const relevant = node => node?.nodeType === 1
    && (node.matches(critical) || Boolean(node.querySelector(critical)) || node.tagName === 'STYLE');
  const record = event => {
    collector.mutationEventsSeen++;
    if (collector.mutations.length < 200) collector.mutations.push({ at: performance.now(),
      documentTimeOrigin: performance.timeOrigin, documentIdentity: ids.document,
      semanticEpoch: ids.semanticEpoch, ...event });
  };
  const observer = new MutationObserver(records => {
    for (const mutation of records) {
      if (mutation.type === 'attributes') {
        const current = mutation.target.getAttribute(mutation.attributeName);
        const root = mutation.target === document.documentElement;
        if (root && semantic.has(mutation.attributeName) && mutation.oldValue !== current) ids.semanticEpoch++;
        if ((root && rootDiagnostics.has(mutation.attributeName)) || mutation.target.matches?.(critical)) {
          record({ kind: 'attribute', target: describe(mutation.target), name: mutation.attributeName,
            oldValue: mutation.oldValue?.slice(0, 160) ?? null, value: current?.slice(0, 160) ?? null });
        }
      } else if (mutation.type === 'characterData' && mutation.target.parentElement?.tagName === 'STYLE') {
        record({ kind: 'style-text', length: mutation.target.textContent.length });
      } else if (mutation.type === 'childList') {
        const added = [...mutation.addedNodes].filter(relevant);
        const removed = [...mutation.removedNodes].filter(relevant);
        if (added.length || removed.length || mutation.target.tagName === 'STYLE') {
          record({ kind: 'child-list', target: describe(mutation.target),
            added: added.slice(0, 5).map(describe), removed: removed.slice(0, 5).map(describe) });
        }
      }
    }
  });
  observer.observe(document.documentElement, { subtree: true, attributes: true,
    attributeOldValue: true, childList: true, characterData: true,
    attributeFilter: [...rootDiagnostics, 'style', 'class'] });
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const changed = event => { ids.semanticEpoch++; record({ kind: 'reduced-motion-change', reduce: event.matches }); };
  media.addEventListener('change', changed);
  let previous = performance.now();
  let lastSample = previous;
  let frame;
  function tick(now) {
    if (collector.stopped) return;
    if (collector.intervals.length < 4000) collector.intervals.push(now - previous);
    previous = now;
    if (now - lastSample >= 100) {
      if (collector.samples.length < 400) collector.samples.push(take());
      lastSample = now;
    }
    frame = requestAnimationFrame(tick);
  }
  collector.stop = () => {
    collector.stopped = true; cancelAnimationFrame(frame);
    observer.disconnect(); media.removeEventListener('change', changed);
  };
  frame = requestAnimationFrame(tick);
})()`;

export const drainCollectorExpression = `(() => {
  const collector = globalThis.__openPetsNativeCollector;
  if (!collector) return null;
  const mutationEventsSeen = collector.mutationEventsSeen;
  collector.mutationEventsSeen = 0;
  return { observations: collector.samples.splice(0), mutations: collector.mutations.splice(0),
    intervals: collector.intervals.splice(0), mutationEventsSeen };
})()`;

export const stopCollectorExpression = 'globalThis.__openPetsNativeCollector?.stop()';
