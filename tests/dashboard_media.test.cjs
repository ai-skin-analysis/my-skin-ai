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
                setAttribute() {}, removeAttribute() {}, focus() {}, replaceChildren() {}, append() {},
                querySelector: () => element(`${id}-text`),
                click() { this.clicked = true; },
                play: async () => {},
                getContext: () => ({ drawImage() {} }),
                toBlob: callback => callback(new Blob(['camera'], { type: 'image/jpeg' })),
            });
        }
        return nodes.get(id);
    };
    const context = vm.createContext({
        Blob, File, console, AbortController,
        URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
        Image: class {
            constructor() { this.width = 640; this.height = 480; }
            set src(value) { queueMicrotask(() => this.onload()); }
        },
        document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [],
            createElement: tag => element(`created-${tag}`) },
        navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
        createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
        setTimeout: (callback, ms) => ms === 7500 ? null : setTimeout(callback, ms),
        clearTimeout,
        isSecureContext: true,
    });
    context.window = context;
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.media = {
        presentImage, clearImage, openCamera, closeCamera, takePhoto, decodeScanImage,
        scanFailureMessage, showProcessingError, submitPrivateScan, userRequest, inspectPreparedScanImage, requireSession,
        refreshPrivateStorageStatus,
        mockInspection: () => { preparePrivateScanImage = async file => file;
            inspectPreparedScanImage = async () => ({ status: 'ready', summary: 'quality only' }); },
        mockStorageAndPresenter: (presenter, ready = true) => { privateStorageReady = ready; scanResultModule = Promise.resolve(presenter); },
        selected: () => selectedScanImage, source: () => selectedScanSource
    };})();`), context);
    return { context, media: context.media, element, revoked };
}
const photo = name => new File(['image'], name, { type: 'image/jpeg' });

test('valid user session opens dashboard despite optional profile/storage outages', async () => {
    const { context, media, element } = environment();
    const redirects = [];
    context.location = { replace: path => redirects.push(path) };
    context.fetch = async path => path === '/api/account/me'
        ? { ok: true, status: 200, json: async () => ({ user: { role: 'user', name: 'test', email: '' } }) }
        : { ok: false, status: 503, json: async () => ({ message: 'storage unavailable' }) };
    await media.requireSession();
    assert.deepEqual(redirects, []);
    assert.equal(element('dashboardMain').classList.contains('hidden'), false);
});

test('session service errors show retry without sending a valid cookie back into a loop', async () => {
    for (const failure of ['network', '503', 'invalid-json']) {
        const { context, media, element } = environment();
        const redirects = [];
        context.location = { replace: path => redirects.push(path) };
        context.fetch = async () => {
            if (failure === 'network') throw new Error('offline');
            return { ok: failure !== '503', status: failure === '503' ? 503 : 200,
                json: async () => { if (failure === 'invalid-json') throw new Error('not json'); return {}; } };
        };
        await media.requireSession();
        assert.deepEqual(redirects, []);
        assert.equal(element('dashboardSessionError').classList.contains('hidden'), false);
        assert.equal(element('dashboardMain').classList.contains('hidden'), true);
        assert.equal(element('dashboardSessionRetryButton').disabled, false);
    }
});

test('explicitly rejected session returns to sign-in with automatic restore suppressed', async () => {
    for (const status of [401, 403]) {
        const { context, media } = environment();
        const redirects = [];
        context.location = { replace: path => redirects.push(path) };
        context.fetch = async () => ({ ok: false, status, json: async () => ({ user: null }) });
        await media.requireSession();
        assert.deepEqual(redirects, ['/?signin=1']);
    }
});

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

test('out-of-scope guidance covers unrelated content rather than only bags', () => {
    const { media, element } = environment();
    const message = media.scanFailureMessage({ code: 'OUT_OF_SCOPE' });
    assert.match(message, /ข้อมูลผิดพลาด/);
    for (const text of ['รอยโรคผิวหนัง', 'สิ่งของ', 'สัตว์', 'อาหาร', 'เอกสาร', 'ภาพหน้าจอ', 'วิว']) assert.ok(message.includes(text));
    media.showProcessingError(message, 'not sent', 'OUT_OF_SCOPE');
    assert.equal(element('dashboardProcessingTitle').textContent, 'ข้อมูลผิดพลาด');
    assert.equal(element('dashboardProcessingModal').dataset.processing, 'error');
    assert.equal(element('dashboardProcessingModal').classList.contains('hidden'), false);
});

test('uncertain content is not presented as a confident non-lesion finding', () => {
    const { media } = environment();
    assert.match(media.scanFailureMessage({ code: 'UNCERTAIN_CONTENT' }), /ตรวจสอบไม่ได้อย่างมั่นใจ/);
    assert.equal(media.scanFailureMessage({ code: 'MODEL_UNAVAILABLE', message: 'unavailable' }), 'unavailable');
});

test('unsupported lesion keeps specialist guidance distinct from invalid input and hides stale comparisons', () => {
    const { media, element } = environment();
    element('dashboardScanResult').classList.remove('hidden');
    const message = media.scanFailureMessage({ code: 'UNSUPPORTED_LESION' });
    media.showProcessingError(message, 'ภาพยังอยู่บนอุปกรณ์', 'UNSUPPORTED_LESION');
    assert.match(message, /แพทย์ผู้เชี่ยวชาญ/);
    assert.ok(!message.includes('ข้อมูลผิดพลาด'));
    assert.match(element('dashboardProcessingTitle').textContent, /ขอบเขต/);
    assert.match(element('dashboardProcessingDetail').textContent, /ไม่ได้หมายความว่าผิวปกติ/);
    assert.equal(element('dashboardProcessingCloseButton').textContent, 'รับทราบ');
    assert.equal(element('dashboardProcessingModal').dataset.processing, 'error');
    assert.equal(element('dashboardScanResult').classList.contains('hidden'), true);
});

test('upload or history failure never falsely claims the image was not sent', () => {
    const { media, element } = environment();
    media.showProcessingError('history failed', 'ภาพถูกส่งถึงพื้นที่ส่วนตัวแล้ว แต่ยังบันทึกประวัติไม่สำเร็จ');
    assert.ok(!element('dashboardProcessingDetail').textContent.includes('ยังอยู่บนอุปกรณ์'));
    assert.match(element('dashboardProcessingImageState-text').textContent, /ถูกส่งถึง/);
});

test('missing image opens an actionable error modal without sending a request', async () => {
    const { context, media, element } = environment();
    context.fetch = () => { throw new Error('must not send'); };
    await media.submitPrivateScan();
    assert.match(element('dashboardProcessingError').textContent, /ไม่พบภาพ/);
    assert.equal(element('dashboardProcessingTitle').textContent, 'ข้อมูลผิดพลาด');
});

test('missing semantic models prevent upload and false scan-success history', async () => {
    const { context, media, element } = environment();
    const requests = [];
    context.fetch = async path => {
        requests.push(path);
        return { ok: true, json: async () => ({ ok: true, classificationAvailable: false,
            scopeFilterAvailable: false, message: 'โมเดลยังไม่พร้อม' }) };
    };
    await media.presentImage(photo('anything.jpg'), 'upload');
    element('dashboardLesionImageInput').checked = true;
    element('dashboardScanConsentInput').checked = true;
    media.mockInspection();
    await media.submitPrivateScan();
    assert.deepEqual(requests, ['/api/user/scan/research/readiness']);
    assert.equal(element('dashboardProcessingTitle').textContent, 'ระบบวิเคราะห์ภาพยังไม่พร้อม');
    assert.equal(element('dashboardProcessingModal').dataset.processing, 'error');
    assert.ok(media.selected());
});

test('API error codes survive request handling for the correct modal message', async () => {
    const { context, media } = environment();
    context.fetch = async () => ({ ok: false, json: async () => ({ ok: false, code: 'OUT_OF_SCOPE', message: 'rejected' }) });
    await assert.rejects(media.userRequest('/api/test'), error => error.code === 'OUT_OF_SCOPE');
});

test('storage readiness can recover without discarding the selected image', async () => {
    const { context, media } = environment();
    const image = photo('lesion.jpg');
    await media.presentImage(image, 'upload');
    let configured = false;
    context.fetch = async (path, options) => {
        assert.equal(path, '/api/user/storage-status');
        assert.equal(options.cache, 'no-store');
        return { ok: true, json: async () => ({ ok: true, configured }) };
    };
    assert.equal(await media.refreshPrivateStorageStatus(), false);
    configured = true;
    assert.equal(await media.refreshPrivateStorageStatus(), true);
    assert.equal(media.selected(), image);
});

test('a fresh unavailable or failed storage check blocks upload despite cached readiness', async () => {
    for (const failure of ['unconfigured', 'network', 'http', 'invalid-json', 'non-boolean']) {
        const { context, media, element } = environment();
        const image = photo('lesion.jpg');
        await media.presentImage(image, 'upload');
        element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
        media.mockInspection(); media.mockStorageAndPresenter({});
        const requests = [];
        context.fetch = async path => {
            requests.push(path);
            if (path.endsWith('/readiness')) return { ok: true, json: async () => ({ ok: true, researchAvailable: true, releaseStatus: 'research_only' }) };
            assert.equal(path, '/api/user/storage-status');
            if (failure === 'network') throw new Error('offline');
            return { ok: failure !== 'http', json: async () => {
                if (failure === 'invalid-json') throw new Error('not json');
                return { ok: true, configured: failure === 'non-boolean' ? 'true' : false };
            } };
        };
        await media.submitPrivateScan();
        assert.deepEqual(requests, ['/api/user/scan/research/readiness', '/api/user/storage-status']);
        assert.equal(media.selected(), image);
        assert.equal(element('dashboardSubmitScanButton').disabled, false);
        assert.equal(element('dashboardProcessingModal').dataset.processing, 'error');
        assert.match(element('dashboardProcessingError').textContent, /พื้นที่ส่วนตัว/);
        assert.match(element('dashboardProcessingImageState-text').textContent, /ยังไม่ได้ถูกจัดเก็บ/);
    }
});

test('a semantic rejection never falls back to a quality-only scan record', async () => {
    const { context, media, element } = environment();
    const requests = [];
    context.fetch = async path => {
        requests.push(path);
        return { ok: true, json: async () => path.endsWith('/readiness')
            ? { ok: true, researchAvailable: true, releaseStatus: 'research_only' }
            : path === '/api/user/storage-status' ? { ok: true, configured: true }
            : { ok: false, code: 'UNSUPPORTED_LESION' } };
    };
    await media.presentImage(photo('image.jpg'), 'upload');
    element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
    media.mockInspection(); media.mockStorageAndPresenter({});
    await media.submitPrivateScan();
    assert.deepEqual(requests, ['/api/user/scan/research/readiness', '/api/user/storage-status', '/api/user/scan/research/upload']);
    assert.match(element('dashboardProcessingTitle').textContent, /ขอบเขต/);
    assert.ok(media.selected());
});

test('network failure during PUT shows an unknown transfer state, not a false not-uploaded claim', async () => {
    const { context, media, element } = environment();
    context.fetch = async path => {
        if (path === '/test-private-upload') throw new Error('Network error');
        return { ok: true, json: async () => path.endsWith('/readiness')
            ? { ok: true, researchAvailable: true, releaseStatus: 'research_only' }
            : path === '/api/user/storage-status' ? { ok: true, configured: true }
            : { ok: true, upload: { id: 'test', url: '/test-private-upload' } } };
    };
    await media.presentImage(photo('image.jpg'), 'upload');
    element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
    media.mockInspection(); media.mockStorageAndPresenter({});
    await media.submitPrivateScan();
    assert.match(element('dashboardProcessingImageState-text').textContent, /ยังยืนยันไม่ได้/);
    assert.ok(media.selected());
});

test('storage acknowledgement without a model result does not show classification success', async () => {
    const { context, media, element } = environment();
    const presenter = await import('../vercel-public/research-result.js');
    context.fetch = async path => ({ ok: true, json: async () => path.endsWith('/readiness')
        ? { ok: true, researchAvailable: true, releaseStatus: 'research_only' }
        : path === '/api/user/storage-status' ? { ok: true, configured: true }
        : path.endsWith('/upload') ? { ok: true, upload: { id: 'test', url: '/test-private-upload' } }
        : { ok: true, storedImage: true, message: 'storage only' } });
    await media.presentImage(photo('image.jpg'), 'upload');
    element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
    media.mockInspection(); media.mockStorageAndPresenter(presenter);
    await media.submitPrivateScan();
    assert.equal(element('dashboardProcessingModal').dataset.processing, 'error');
    assert.match(element('dashboardProcessingImageState-text').textContent, /บันทึกรายการแล้ว/);
    assert.match(element('dashboardProcessingError').textContent, /ผลวิเคราะห์ไม่ครบถ้วน/);
    assert.ok(media.selected());
});

test('brightness alone does not reject a dark but detailed image as unusable', async () => {
    const { media, element } = environment();
    element('created-canvas').getContext = () => ({ drawImage() {}, getImageData: (_x, _y, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let index = 0; index < width * height; index++) {
            const value = 20 + (index % 7) * 4;
            data.set([value, value, value, 255], index * 4);
        }
        return { data };
    } });
    const quality = await media.inspectPreparedScanImage(photo('dark-detailed.jpg'));
    assert.equal(quality.status, 'ready');
    assert.ok(quality.qualityWarning);
    assert.match(quality.summary, /ยังไม่ได้ยืนยัน/);
});

test('a blank black image is rejected as a technical-quality failure, not as a disease finding', async () => {
    const { media, element } = environment();
    element('created-canvas').getContext = () => ({ drawImage() {}, getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) });
    assert.equal((await media.inspectPreparedScanImage(photo('blank.jpg'))).status, 'retake-light');
});

test('research rejection clears server upload state, retains local preview and permits choosing a new image', async () => {
    const { context, media, element } = environment();
    const presenter = await import('../vercel-public/research-result.js');
    const requests = [];
    context.fetch = async (path, options) => {
        requests.push(path);
        if (path.endsWith('/research/upload')) assert.equal(JSON.parse(options.body).researchConsentVersion, 'skin-research-20261006-v1');
        return { ok: true, json: async () => path.endsWith('/readiness')
            ? { ok: true, researchAvailable: true, releaseStatus: 'research_only' }
            : path === '/api/user/storage-status' ? { ok: true, configured: true }
            : path.endsWith('/upload') ? { ok: true, upload: { id: 'test', url: '/test-private-upload' } }
            : { ok: true, storedImage: false, temporaryUploadDeleted: true, analysis: {
                ok: false, code: 'NON_SKIN_IMAGE', releaseStatus: 'research_only', modelVersion: 'derm-local-e10f89ad2ac8',
                publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
            } } };
    };
    await media.presentImage(photo('object.jpg'), 'upload');
    element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
    media.mockInspection(); media.mockStorageAndPresenter(presenter);
    await media.submitPrivateScan();
    assert.ok(media.selected()); assert.equal(element('dashboardSubmitScanButton').disabled, false);
    assert.match(element('dashboardProcessingTitle').textContent, /ข้อมูลภาพ?ผิดพลาด|ข้อมูลผิดพลาด/);
    assert.match(element('dashboardProcessingImageState-text').textContent, /ลบภาพ/);
    assert.equal(requests.length, 5); assert.equal(requests.some(path => path.endsWith('/record')), false);
});

test('upload and camera images use the same real research path and only valid model results show success', async () => {
    const presenter = await import('../vercel-public/research-result.js');
    const { SCAN_CLASSES } = await import('../vercel-public/scan-result.js');
    for (const source of ['upload', 'camera']) {
        const { context, media, element } = environment();
        let rendered = false;
        context.fetch = async (path, options) => {
            if (path.endsWith('/research/upload')) assert.equal(JSON.parse(options.body).source, source);
            return { ok: true, json: async () => path.endsWith('/readiness')
                ? { ok: true, researchAvailable: true, releaseStatus: 'research_only' }
                : path === '/api/user/storage-status' ? { ok: true, configured: true }
                : path.endsWith('/upload') ? { ok: true, upload: { id: 'test', url: '/test-private-upload' } }
                : { ok: true, storedImage: true, message: 'experimental', analysis: {
                    ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only', classificationStatus: 'experimental',
                    modelVersion: 'derm-local-e10f89ad2ac8', publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
                    diagnostics: SCAN_CLASSES.map((row, index) => ({ id: row.id, score: index ? 0.1 / 19 : 0.9 })),
                } } };
        };
        await media.presentImage(photo('lesion.jpg'), source, source);
        element('dashboardLesionImageInput').checked = element('dashboardScanConsentInput').checked = true;
        // Both media sources must recover from the unavailable status cached
        // when the dashboard first loaded, using a new check before upload.
        media.mockInspection(); media.mockStorageAndPresenter({ ...presenter, renderResearchResult: () => { rendered = true; } }, false);
        await media.submitPrivateScan();
        assert.equal(rendered, true, element('dashboardProcessingError').textContent); assert.equal(media.selected(), null);
        assert.equal(element('dashboardProcessingModal').dataset.processing, 'complete');
        assert.match(element('dashboardProcessingTitle').textContent, /เชิงทดลอง/);
    }
});
