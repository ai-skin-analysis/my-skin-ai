const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../vercel-public/dashboard.js'), 'utf8');
function environment() {
    const nodes = new Map();
    const revoked = [];
    let nextUrl = 0;
    const element = (id) => {
        if (!nodes.has(id)) {
            const classes = new Set(['hidden']);
            nodes.set(id, {
                value: '', textContent: '', disabled: false, checked: false,
                dataset: {}, videoWidth: 4000, videoHeight: 3000,
                classList: {
                    add: (...names) => names.forEach(name => classes.add(name)),
                    remove: (...names) => names.forEach(name => classes.delete(name)),
                    contains: name => classes.has(name),
                    toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
                },
                setAttribute() {}, removeAttribute() {}, focus() {},
                click() { this.clicked = true; },
                play: async () => {},
                getContext: () => ({ drawImage() {} }),
                toBlob: callback => callback(new Blob(['camera'], { type: 'image/jpeg' })),
            });
        }
        return nodes.get(id);
    };
    const context = vm.createContext({
        Blob, File, console,
        URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
        Image: class {
            constructor() { this.width = 640; this.height = 480; }
            set src(value) { queueMicrotask(() => this.onload()); }
        },
        document: { getElementById: element, addEventListener() {} },
        navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
        createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
        setTimeout: (callback, ms) => ms === 7500 ? null : setTimeout(callback, ms),
        clearTimeout,
        isSecureContext: true,
    });
    context.window = context;
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.media = {
        presentImage, clearImage, openCamera, closeCamera, takePhoto, decodeScanImage,
        selected: () => selectedScanImage, source: () => selectedScanSource
    };})();`), context);
    return { context, media: context.media, element, revoked };
}
const photo = name => new File(['image'], name, { type: 'image/jpeg' });

test('select, replace and cancel an image without sending it to a server', async () => {
    const { media, element, revoked } = environment();
    const first = photo('first.jpg');
    assert.equal(await media.presentImage(first, 'upload'), true);
    assert.equal(media.selected(), first);
    assert.equal(element('dashboardSubmitScanButton').disabled, false);
    await media.presentImage(photo('second.jpg'), 'upload');
    assert.ok(revoked.length > 0);
    media.clearImage();
    assert.equal(media.selected(), null);
    assert.equal(element('dashboardSubmitScanButton').disabled, true);
    assert.equal(element('dashboardImagePreviewPanel').classList.contains('hidden'), true);
});

test('cancelling while decoding prevents a late image from reappearing', async () => {
    const { context, media } = environment();
    let finish;
    context.createImageBitmap = () => new Promise(resolve => { finish = resolve; });
    const pending = media.presentImage(photo('slow.jpg'), 'upload');
    media.clearImage();
    finish({ width: 640, height: 480, close() {} });
    assert.equal(await pending, false);
    assert.equal(media.selected(), null);
});

test('browser image decoder works when createImageBitmap is unavailable', async () => {
    const { context, media } = environment();
    context.createImageBitmap = undefined;
    assert.equal(await media.presentImage(photo('fallback.jpg'), 'upload'), true);
});

test('corrupt images cannot replace a previously valid selection', async () => {
    const { context, media } = environment();
    const original = photo('valid.jpg');
    await media.presentImage(original, 'upload');
    context.createImageBitmap = async () => { throw new Error('bad bytes'); };
    context.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
    assert.equal(await media.presentImage(photo('corrupt.jpg'), 'upload'), false);
    assert.equal(media.selected(), original);
});

test('a stream returned after the user closes the camera is stopped', async () => {
    const { context, media } = environment();
    let finish;
    let stopped = 0;
    context.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { finish = resolve; });
    const opening = media.openCamera();
    media.closeCamera();
    finish({ getTracks: () => [{ stop: () => { stopped += 1; } }] });
    await opening;
    assert.equal(stopped, 1);
});

test('camera capture works without DataTransfer and limits the captured image dimensions', async () => {
    const { media, element } = environment();
    let capturedWidth;
    element('dashboardCameraCanvas').toBlob = function (callback) {
        capturedWidth = this.width;
        callback(new Blob(['camera'], { type: 'image/jpeg' }));
    };
    await media.openCamera();
    await media.takePhoto();
    assert.equal(capturedWidth, 2048);
    assert.equal(media.source(), 'camera');
    assert.equal(media.selected().type, 'image/jpeg');
    assert.equal(element('dashboardCameraModal').classList.contains('hidden'), true);
});

test('camera denial leaves an actionable message and capture disabled', async () => {
    const { context, media, element } = environment();
    context.navigator.mediaDevices.getUserMedia = async () => { throw { name: 'NotAllowedError' }; };
    await media.openCamera();
    assert.equal(element('dashboardTakePhotoButton').disabled, true);
    assert.match(element('dashboardCameraStatus').textContent, /อนุญาต/);
});

test('devices without streaming camera support can use native capture', async () => {
    const { context, media, element } = environment();
    context.navigator.mediaDevices = undefined;
    await media.openCamera();
    assert.equal(element('dashboardNativeCameraInput').clicked, true);
});
