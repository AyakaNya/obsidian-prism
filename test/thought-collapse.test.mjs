import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function makeFakeElement(tag, attrs = {}, text = '') {
  const attrMap = new Map(Object.entries(attrs));
  let _text = text;
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isConnected: true,
    parentElement: null,
    children: [],
    classList: {
      contains: () => false,
      add() {},
      remove() {},
    },
    style: { setProperty() {} },
    get textContent() {
      return _text;
    },
    set textContent(v) {
      _text = String(v);
    },
    getAttribute(k) {
      return attrMap.has(k) ? String(attrMap.get(k)) : null;
    },
    setAttribute(k, v) {
      attrMap.set(k, String(v));
    },
    removeAttribute(k) {
      attrMap.delete(k);
    },
    hasAttribute(k) {
      return attrMap.has(k);
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    clickCalls: 0,
    click() {
      this.clickCalls++;
      const cur = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', cur ? 'false' : 'true');
    },
  };
  return el;
}

test('stream-choreography thoughtCollapse: auto-collapse completed thoughts, respect manual toggles, and switch cleanly to keep-expanded', async () => {
  const code = fs.readFileSync(path.join(rootDir, 'stream-choreography.js'), 'utf8');
  const observers = [];

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.target = null;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
      this.disconnected = false;
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (!this.disconnected) this.cb([]);
    }
  }

  const doneTrig = makeFakeElement('button', { 'data-testid': 'thinking-collapsible-trigger', 'aria-expanded': 'true' }, 'Thought for 4s');
  const streamTrig = makeFakeElement('button', { 'data-testid': 'thinking-collapsible-trigger', 'aria-expanded': 'true' }, 'Thinking...');
  const triggers = [doneTrig, streamTrig];

  const conv = makeFakeElement('div', { 'data-testid': 'conversation-view' });
  conv.querySelectorAll = (sel) => (sel.includes('thinking-collapsible-trigger') ? triggers : []);

  const fakeDoc = {
    documentElement: makeFakeElement('html'),
    body: makeFakeElement('body'),
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('conversation-view')) return [conv];
      if (sel.includes('thinking-collapsible-trigger')) return triggers;
      return [];
    },
  };

  let mode = 'auto';
  const sandbox = {
    globalThis: null,
    window: {},
    document: fakeDoc,
    MutationObserver: FakeMutationObserver,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    Math,
    Array,
    Set,
    Map,
    WeakMap,
    WeakSet,
    Number,
    String,
    Boolean,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);

  const ctl = sandbox.__agPrismStreamChoreography.createStreamChoreographyController({
    motionEngine: null,
    isDestroyed: () => false,
    isMotionStandardOrUltra: () => false,
    isMotionUltra: () => false,
    isConvRunning: () => false,
    getThoughtCollapseMode: () => mode,
    isThoughtIsolatedNode: () => false,
    isThoughtMutationRecord: () => false,
    isManagedThoughtPanel: () => false,
    setAttrIfChanged: (e, k, v) => e.setAttribute(k, v),
    runGuardedMut: (fn) => fn(),
    cloneCachedSvgElement: () => null,
    buildBrandMarkSvg: () => '',
    applySingleHostIcon: () => {},
    rippleCtl: null,
    convAuraCtl: null,
    notifyMascot: () => {},
  });

  // 1) Auto-collapse mode folds finished thought while keeping active streaming thought untouched
  ctl.syncThoughtCollapse();
  assert.equal(doneTrig.getAttribute('aria-expanded'), 'false', 'Finished thought must auto-collapse');
  assert.equal(streamTrig.getAttribute('aria-expanded'), 'true', 'Streaming thought must stay open while thinking');

  // 2) Once streaming finishes, stream watcher auto-collapses it immediately
  streamTrig.textContent = 'Thought for 3s';
  const streamObs = observers.find((o) => o.target === streamTrig && !o.disconnected);
  assert.ok(streamObs, 'Streaming thought should have an end-of-stream observer');
  streamObs.trigger();
  assert.equal(streamTrig.getAttribute('aria-expanded'), 'false', 'Newly finished thought must auto-collapse');

  // 3) User manually expands doneTrig -> must NOT be auto-collapsed again
  ctl.onUserToggleThoughtTrigger(doneTrig, { isTrusted: true });
  doneTrig.setAttribute('aria-expanded', 'true');
  ctl.syncThoughtCollapse();
  assert.equal(doneTrig.getAttribute('aria-expanded'), 'true', 'Manually expanded thought must stay open in auto mode');

  // 4) Switching to keep-expanded restores auto-collapsed streamTrig and guards against host auto-collapse
  mode = 'keep';
  ctl.syncThoughtCollapse();
  assert.equal(streamTrig.getAttribute('aria-expanded'), 'true', 'Switching to keep mode should restore auto-collapsed thought');

  const keepObs = observers.find((o) => o.target === streamTrig && !o.disconnected);
  assert.ok(keepObs, 'Keep mode should watch thought trigger for host auto-collapse');
  streamTrig.setAttribute('aria-expanded', 'false'); // simulate host auto-collapsing
  keepObs.trigger();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(streamTrig.getAttribute('aria-expanded'), 'true', 'Keep mode must reopen host auto-collapsed thought');

  // 5) User manually collapses streamTrig in keep mode -> must stay collapsed
  ctl.onUserToggleThoughtTrigger(streamTrig, { isTrusted: true });
  streamTrig.setAttribute('aria-expanded', 'false');
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(streamTrig.getAttribute('aria-expanded'), 'false', 'Manually collapsed thought must stay collapsed in keep mode');

  // 6) Switching back to auto mode cleans up keep watchers
  mode = 'auto';
  ctl.syncThoughtCollapse();
  ctl.clearThoughtCollapseWatchers();
  assert.ok(observers.every((o) => o.disconnected), 'All observers must disconnect on cleanup');
});
