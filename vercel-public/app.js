// Keep modal behavior consistent for keyboard and screen-reader users.
        // The page never stores a previous focus target beyond this browser tab.
        const modalFocusRestore = new Map();
        function getOpenAccessibleModal() {
            return [...document.querySelectorAll('[data-accessible-modal="true"]')]
                .filter((modal) => !modal.classList.contains('hidden'))
                .at(-1) || null;
        }
        function getFocusableElements(container) {
            return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter((element) => !element.closest('[hidden], .hidden'));
        }
        function syncAccessibleModalPageState() {
            const hasOpenModal = Boolean(getOpenAccessibleModal());
            document.documentElement.classList.toggle('overflow-hidden', hasOpenModal);
            document.body.classList.toggle('overflow-hidden', hasOpenModal);
        }
        function showAccessibleModal(modalId, initialFocusSelector = '') {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            if (modal.classList.contains('hidden')) {
                modalFocusRestore.set(modalId, document.activeElement instanceof HTMLElement ? document.activeElement : null);
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.setAttribute('aria-hidden', 'false');
            syncAccessibleModalPageState();
            window.setTimeout(() => {
                const initial = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
                const target = initial || getFocusableElements(modal)[0];
                if (target instanceof HTMLElement) target.focus();
            }, 0);
        }
        function hideAccessibleModal(modalId) {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.setAttribute('aria-hidden', 'true');
            syncAccessibleModalPageState();
            const restoreTarget = modalFocusRestore.get(modalId);
            modalFocusRestore.delete(modalId);
            if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) {
                window.setTimeout(() => restoreTarget.focus(), 0);
            }
        }
        document.addEventListener('keydown', (event) => {
            const modal = getOpenAccessibleModal();
            if (!modal) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                const closeButton = modal.querySelector('[data-modal-close]');
                if (closeButton instanceof HTMLElement) closeButton.click();
                else hideAccessibleModal(modal.id);
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = getFocusableElements(modal);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        const eilikContainer = document.getElementById('eilik-space-container');
        const eilikRender = document.getElementById('eilik-render');
        const eilikLeftArm = document.getElementById('eilik-left-arm');
        const eilikRightArm = document.getElementById('eilik-right-arm');
        const eilikFloorShadow = document.getElementById('eilik-floor-shadow');
        const eilikSpeech = document.getElementById('eilik-speech');
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const eilikPhrases = [
            'สแกนเนอร์พร้อมแล้ว เลือกภาพที่ชัดเจนเพื่อเริ่มคัดกรองได้เลยครับ',
            'ผิวดีเริ่มจากการสังเกตอาการ หากกังวลควรพบแพทย์ผิวหนังนะครับ',
            'พร้อมช่วยแนะนำขั้นตอนการใช้ระบบอย่างปลอดภัยครับ',
            'อย่าลืมอ่านและยืนยันความยินยอมก่อนส่งภาพเพื่อคัดกรองนะครับ',
            'ผลจากระบบเป็นเพียงการคัดกรองจากภาพ ไม่ใช่การวินิจฉัยครับ'
        ];

        function clearEilikAnimations() {
            eilikRender.classList.remove('eilik-state-float', 'eilik-state-walk', 'eilik-state-jump', 'eilik-state-spin');
            eilikLeftArm.classList.remove('eilik-arm-left-up');
            eilikRightArm.classList.remove('eilik-arm-right-up', 'eilik-arm-right-wave');
        }

        function roamEilikEverywhere() {
            if (reduceMotion || eilikRender.classList.contains('eilik-state-jump') || eilikRender.classList.contains('eilik-state-spin') || eilikRightArm.classList.contains('eilik-arm-right-wave')) return;

            const robotWidth = Math.min(240, Math.max(170, window.innerWidth * 0.26));
            const maxX = Math.max(20, window.innerWidth - robotWidth - 20);
            const maxY = Math.max(110, window.innerHeight - 250);
            const randomX = Math.floor(Math.random() * maxX) + 10;
            const randomY = Math.floor(Math.random() * (maxY - 80)) + 80;
            const currentX = parseInt(eilikContainer.style.left, 10) || 0;
            const distance = Math.abs(randomX - currentX);

            clearEilikAnimations();
            eilikRender.classList.add(distance > 300 ? 'eilik-state-walk' : 'eilik-state-float');
            eilikContainer.style.transitionDuration = distance > 300 ? '2500ms' : '3500ms';
            eilikFloorShadow.style.transform = distance > 300 ? 'scale(.6)' : 'scale(1)';
            eilikSpeech.textContent = eilikPhrases[Math.floor(Math.random() * eilikPhrases.length)];
            eilikContainer.style.left = `${randomX}px`;
            eilikContainer.style.top = `${randomY}px`;
        }

        function resetEilikToNormal() {
            clearEilikAnimations();
            eilikRender.classList.add('eilik-state-float');
            roamEilikEverywhere();
        }

        function welcomeEilik() {
            clearEilikAnimations();
            eilikRender.classList.add('eilik-state-float');
            eilikRightArm.classList.add('eilik-arm-right-wave');
            eilikSpeech.textContent = 'สวัสดีครับ! ผมอิลลิค ผู้ช่วย AI ยินดีต้อนรับสู่ Smart Skin AI ครับ';
            if (!reduceMotion) {
                window.setTimeout(() => {
                    eilikRightArm.classList.remove('eilik-arm-right-wave');
                    roamEilikEverywhere();
                    window.setInterval(roamEilikEverywhere, 7000);
                }, 4000);
            }
        }

        eilikRender.addEventListener('click', () => {
            if (reduceMotion) {
                eilikSpeech.textContent = 'สวัสดีครับ ผมอิลลิค พร้อมช่วยแนะนำการใช้งานระบบครับ';
                return;
            }
            clearEilikAnimations();
            const actions = ['greet', 'spin', 'jump'];
            const action = actions[Math.floor(Math.random() * actions.length)];
            if (action === 'greet') {
                eilikRightArm.classList.add('eilik-arm-right-wave');
                eilikSpeech.textContent = 'สวัสดีครับ! ถ้ามีอาการน่ากังวลหรือเปลี่ยนแปลงเร็ว ควรพบแพทย์ผิวหนังนะครับ';
                window.setTimeout(resetEilikToNormal, 2500);
            } else if (action === 'spin') {
                eilikRender.classList.add('eilik-state-spin');
                eilikSpeech.textContent = 'ว้าว! พร้อมเริ่มต้นดูแลผิวอย่างรอบคอบแล้วครับ';
                window.setTimeout(resetEilikToNormal, 1000);
            } else {
                eilikRender.classList.add('eilik-state-jump');
                eilikLeftArm.classList.add('eilik-arm-left-up');
                eilikRightArm.classList.add('eilik-arm-right-up');
                eilikSpeech.textContent = 'เยี่ยมเลย! เลือกภาพให้ชัดและอ่านคำแนะนำก่อนเริ่มคัดกรองนะครับ';
                window.setTimeout(resetEilikToNormal, 2500);
            }
        });

        window.setTimeout(welcomeEilik, 900);

        let currentLat = null;
        let currentLng = null;
        let environmentLocationConsent = false;
        let mapLocationConsent = false;
        // This is a separate, one-time approval for a Google Maps URL that
        // contains coordinates. A later checkbox tick alone is not enough to
        // reuse a position acquired for OpenStreetMap.
        let mapGoogleMapsLocationConsent = false;
        let lastMapQuery = 'คลินิกหมอผิวหนัง';
        let currentLocationMeta = {
            capturedAt: null,
            accuracyMeters: null,
            approximateName: '',
        };
        let mapFrameIsExternal = false;

        let liveEnvData = {
            uv: { val: 0, status: "กำลังโหลด...", title: "UV Index (ดัชนีรังสีอุลตราไวโอเลต)", badge: "", badgeClass: "", iconBg: "bg-amber-100 text-amber-600", icon: "sun", desc: "" },
            temp: { val: "0°C", status: "กำลังโหลด...", title: "อุณหภูมิอากาศ (Temperature)", badge: "", badgeClass: "", iconBg: "bg-orange-100 text-orange-600", icon: "thermometer", desc: "" },
            humidity: { val: "0%", status: "กำลังโหลด...", title: "ความชื้นสัมพัทธ์ (Humidity)", badge: "", badgeClass: "", iconBg: "bg-blue-100 text-blue-600", icon: "droplets", desc: "" },
            aqi: { val: "0", status: "กำลังโหลด...", title: "ดัชนีคุณภาพอากาศ (AQI)", badge: "", badgeClass: "", iconBg: "bg-emerald-100 text-emerald-600", icon: "wind", desc: "" }
        };

        document.addEventListener("DOMContentLoaded", () => {
            if (typeof lucide !== 'undefined') lucide.createIcons();
            // Bind the account-panel interactions explicitly. Inline handlers
            // are not dependable under every static-host security policy.
            document.getElementById('btnTabLogin')?.addEventListener('click', () => switchForm('login'));
            document.getElementById('btnTabRegister')?.addEventListener('click', () => switchForm('register'));
            document.getElementById('formLogin')?.addEventListener('submit', submitAccountForm);
            document.getElementById('formRegister')?.addEventListener('submit', submitAccountForm);
            document.getElementById('logoutButton')?.addEventListener('click', logoutAccount);
            restoreAccountSession();
        });

        function openEnvironmentLocationConsent() {
            document.getElementById('environmentLocationConsentCheck').checked = false;
            document.getElementById('environmentLocationConsentStatus').textContent = '';
            showAccessibleModal('environmentLocationConsentModal', '#environmentLocationConsentCheck');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function closeEnvironmentLocationConsent() {
            hideAccessibleModal('environmentLocationConsentModal');
        }

        function insecureLocationContextMessage() {
            return 'ไม่สามารถใช้ตำแหน่งจากลิงก์ HTTP/IP ได้ — โปรดเปิดเว็บผ่าน HTTPS ที่มีใบรับรองเชื่อถือได้ หรือทดสอบบนเครื่องนี้ที่ http://127.0.0.1:5000';
        }

        function locationErrorMessage(error) {
            if (!window.isSecureContext) return insecureLocationContextMessage();
            if (error?.code === 1) return 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง โปรดอนุญาต Location ในเบราว์เซอร์แล้วลองอีกครั้ง';
            if (error?.code === 2) return 'ไม่พบตำแหน่งปัจจุบัน โปรดเปิด GPS หรือเชื่อมต่อเครือข่ายแล้วลองอีกครั้ง';
            if (error?.code === 3) return 'การระบุตำแหน่งใช้เวลานานเกินไป โปรดลองอีกครั้ง';
            return 'ไม่สามารถระบุตำแหน่งได้ในขณะนี้';
        }

        function hasCurrentLocation() {
            return Number.isFinite(currentLat) && Number.isFinite(currentLng);
        }

        function saveFreshBrowserLocation(position) {
            currentLat = position.coords.latitude;
            currentLng = position.coords.longitude;
            currentLocationMeta = {
                capturedAt: Number(position.timestamp) || Date.now(),
                accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
                approximateName: '',
            };
        }

        function roundedCoordinate(value) {
            return Number(Number(value).toFixed(4));
        }

        function setEnvironmentSourceText(text, note = '') {
            const source = document.getElementById('environment-source-text');
            const sourceNote = document.getElementById('environment-source-note');
            if (source) source.textContent = text;
            if (sourceNote && note) sourceNote.textContent = note;
        }

        function setMapLocationStatus(text, isError = false) {
            const status = document.getElementById('mapLocationStatus');
            if (!status) return;
            status.textContent = text;
            status.className = `min-h-4 text-[11px] font-semibold ${isError ? 'text-rose-600' : 'text-teal-700'}`;
        }

        function showMapFrameFallback(text) {
            const frame = document.getElementById('googleMapIframe');
            const fallback = document.getElementById('mapFrameFallback');
            const fallbackText = document.getElementById('mapFrameFallbackText');
            mapFrameIsExternal = false;
            frame.src = '';
            fallbackText.textContent = text;
            fallback.classList.remove('hidden');
            fallback.classList.add('flex');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function loadMapFrame(url) {
            const frame = document.getElementById('googleMapIframe');
            const fallback = document.getElementById('mapFrameFallback');
            mapFrameIsExternal = true;
            fallback.classList.add('hidden');
            fallback.classList.remove('flex');
            frame.src = url;
        }

        function useCurrentLocationForEnvironment() {
            if (!window.isSecureContext) {
                showEnvironmentUnavailable(insecureLocationContextMessage());
                return;
            }
            if (!navigator.geolocation) {
                showEnvironmentUnavailable('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
                return;
            }
            openEnvironmentLocationConsent();
        }

        function approveEnvironmentLocationConsent() {
            const status = document.getElementById('environmentLocationConsentStatus');
            if (!document.getElementById('environmentLocationConsentCheck').checked) {
                status.textContent = 'โปรดยืนยันความเข้าใจก่อนขอตำแหน่งจากเบราว์เซอร์';
                return;
            }
            if (!window.isSecureContext) {
                status.textContent = insecureLocationContextMessage();
                return;
            }
            if (!navigator.geolocation) {
                status.textContent = 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง';
                return;
            }
            closeEnvironmentLocationConsent();
            environmentLocationConsent = true;
            document.getElementById('location-text').textContent = 'กำลังขอตำแหน่งล่าสุดจากอุปกรณ์';
            setEnvironmentSourceText('กำลังขอตำแหน่งล่าสุดจากอุปกรณ์', 'ระบบจะไม่ใช้ตำแหน่งเก่าที่เก็บในหน้าเว็บ และจะเรียกข้อมูลอากาศใหม่หลังได้รับพิกัด');

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    saveFreshBrowserLocation(position);
                    document.getElementById('location-text').textContent = 'กำลังโหลดข้อมูลอากาศตามตำแหน่งล่าสุดของคุณ';
                    fetchLiveWeatherData(currentLat, currentLng, currentLocationMeta);
                },
                (error) => showEnvironmentUnavailable(locationErrorMessage(error)),
                // Request a fresh reading only after the visitor has explicitly consented.
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        }

        function refreshEnvironmentData() {
            if (!environmentLocationConsent || !hasCurrentLocation()) {
                useCurrentLocationForEnvironment();
                return;
            }
            if (!window.isSecureContext || !navigator.geolocation) {
                showEnvironmentUnavailable(!window.isSecureContext
                    ? insecureLocationContextMessage()
                    : 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
                return;
            }
            document.getElementById('location-text').textContent = 'กำลังอัปเดตตำแหน่งและข้อมูลอากาศล่าสุด';
            setEnvironmentSourceText('กำลังอัปเดตข้อมูลอากาศจาก Open-Meteo', 'กำลังขอตำแหน่งใหม่จากอุปกรณ์ก่อนเรียกข้อมูลอากาศ จึงอาจใช้เวลาสักครู่');
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    saveFreshBrowserLocation(position);
                    fetchLiveWeatherData(currentLat, currentLng, currentLocationMeta);
                },
                (error) => showEnvironmentUnavailable(locationErrorMessage(error)),
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        }

        function approximateLocationLabel(data) {
            const address = data?.address || {};
            // Reverse geocoding is only a nearby-area label. It is deliberately
            // not presented as an exact address because device GPS and mapping
            // boundaries can disagree at subdistrict level.
            const area = address.suburb || address.quarter || address.neighbourhood || address.village || address.hamlet || address.subdistrict || '';
            const city = address.municipality || address.town || address.city || address.city_district || address.district || address.county || '';
            const province = address.state || address.province || '';
            return [area, city, province].filter(Boolean).filter((value, index, parts) => parts.indexOf(value) === index).join(' · ');
        }

        async function fetchApproximateLocationName(lat, lng) {
            const roundedLat = roundedCoordinate(lat);
            const roundedLng = roundedCoordinate(lng);
            const response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLng}&zoom=14&addressdetails=1&accept-language=th`);
            if (!response.ok) throw new Error('Location service unavailable');
            return approximateLocationLabel(await response.json());
        }

        async function fetchWithTimeout(url, timeoutMs = 12000) {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(url, { signal: controller.signal });
            } finally {
                window.clearTimeout(timeoutId);
            }
        }

        function weatherCodeLabel(code) {
            const labels = {
                0: 'ท้องฟ้าโปร่ง', 1: 'มีเมฆเล็กน้อย', 2: 'มีเมฆเป็นบางส่วน', 3: 'เมฆมาก',
                45: 'มีหมอก', 48: 'มีหมอกน้ำค้างแข็ง', 51: 'ฝนปรอยเล็กน้อย', 53: 'ฝนปรอย',
                55: 'ฝนปรอยหนัก', 56: 'ฝนเยือกแข็งเล็กน้อย', 57: 'ฝนเยือกแข็งหนัก', 61: 'ฝนเล็กน้อย',
                63: 'ฝนปานกลาง', 65: 'ฝนหนัก', 66: 'ฝนเยือกแข็ง', 67: 'ฝนเยือกแข็งหนัก',
                71: 'หิมะเล็กน้อย', 73: 'หิมะปานกลาง', 75: 'หิมะหนัก', 77: 'เกล็ดหิมะ',
                80: 'ฝนซู่เล็กน้อย', 81: 'ฝนซู่ปานกลาง', 82: 'ฝนซู่หนัก', 85: 'หิมะซู่เล็กน้อย',
                86: 'หิมะซู่หนัก', 95: 'พายุฝนฟ้าคะนอง', 96: 'พายุฝนฟ้าคะนองและลูกเห็บ', 99: 'พายุฝนฟ้าคะนองและลูกเห็บหนัก'
            };
            return labels[Number(code)] || 'ไม่ทราบสภาพท้องฟ้า';
        }

        function formatEnvironmentUpdatedAt(timestamp) {
            return new Intl.DateTimeFormat('th-TH', {
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(timestamp || Date.now()));
        }

        function formatProviderCurrentTime(currentTime, timezone) {
            if (!currentTime) return 'ไม่ระบุเวลา';
            const readableTime = String(currentTime).replace('T', ' ');
            return timezone ? `${readableTime} (${timezone})` : readableTime;
        }

        function formatGpsAccuracy(accuracyMeters) {
            return Number.isFinite(accuracyMeters) ? `ความแม่นยำ GPS ประมาณ ±${Math.round(accuracyMeters)} ม.` : 'ความแม่นยำ GPS ไม่ระบุ';
        }

        async function fetchLiveWeatherData(lat, lng, locationMeta = {}) {
            try {
                const roundedLat = roundedCoordinate(lat);
                const roundedLng = roundedCoordinate(lng);
                const [weatherRes, airRes, locationName] = await Promise.all([
                    fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&current=temperature_2m,relative_humidity_2m,uv_index,weather_code&timezone=auto`),
                    fetchWithTimeout(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${roundedLat}&longitude=${roundedLng}&current=us_aqi&timezone=auto`),
                    fetchApproximateLocationName(lat, lng).catch(() => '')
                ]);
                if (!weatherRes.ok || !airRes.ok) throw new Error('Weather service unavailable');
                const weatherData = await weatherRes.json();
                const airData = await airRes.json();

                const uvVal = Math.round(Number(weatherData.current?.uv_index));
                const rawTempVal = Number(weatherData.current?.temperature_2m);
                const tempVal = Math.round(rawTempVal * 10) / 10;
                const humVal = Math.round(Number(weatherData.current?.relative_humidity_2m));
                const aqiVal = Math.round(Number(airData.current?.us_aqi));
                if (![uvVal, tempVal, humVal, aqiVal].every(Number.isFinite)) throw new Error('Invalid weather data');

                const weatherDescription = weatherCodeLabel(weatherData.current?.weather_code);
                const gpsCapturedAt = formatEnvironmentUpdatedAt(locationMeta.capturedAt);
                const weatherObservedAt = formatProviderCurrentTime(weatherData.current?.time, weatherData.timezone_abbreviation || weatherData.timezone);
                const airObservedAt = formatProviderCurrentTime(airData.current?.time, airData.timezone_abbreviation || airData.timezone);
                currentLocationMeta.approximateName = locationName;
                document.getElementById('location-text').textContent = locationName
                    ? `พื้นที่ใกล้เคียงจากตำแหน่งล่าสุด: ${locationName}`
                    : 'ข้อมูลอากาศตามตำแหน่งล่าสุดของคุณ';
                setEnvironmentSourceText(
                    `แหล่งข้อมูล: Open-Meteo current conditions · อากาศ ${weatherObservedAt} · AQI ${airObservedAt}`,
                    `อุณหภูมิแสดง ${tempVal.toFixed(1)}°C จากกริดพยากรณ์ ไม่ใช่ค่าเซนเซอร์ในโทรศัพท์ พิกัดถูกขอใหม่เวลา ${gpsCapturedAt} และส่งแบบปัดเป็นทศนิยม 4 ตำแหน่ง (${formatGpsAccuracy(locationMeta.accuracyMeters)}) ค่าอาจต่างจากแอปโทรศัพท์ หากใช้ผู้ให้บริการ จุดวัด/กริดพยากรณ์ หรือเวลาอัปเดตคนละแหล่ง`,
                );
                updateCardsUI(uvVal, tempVal, humVal, aqiVal, weatherDescription, locationName);
            } catch (err) {
                showEnvironmentUnavailable(navigator.onLine
                    ? 'เชื่อมต่อบริการข้อมูลอากาศไม่สำเร็จ โปรดลองอีกครั้ง'
                    : 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต จึงยังโหลดข้อมูลอากาศตามตำแหน่งไม่ได้');
            }
        }

        function showEnvironmentUnavailable(message) {
            ['uv', 'temp', 'humidity', 'aqi'].forEach((key) => {
                document.getElementById(`card-${key}-val`).textContent = '—';
                document.getElementById(`card-${key}-status`).textContent = 'ไม่มีข้อมูล';
            });
            document.getElementById('location-text').textContent = message;
            document.getElementById('env-summary-text').textContent = 'ไม่สามารถแสดงข้อมูลอากาศตามตำแหน่งได้ โปรดใช้คำแนะนำทั่วไปและหลีกเลี่ยงการตีความเป็นผลทางการแพทย์';
            setEnvironmentSourceText(
                'ยังไม่มีข้อมูลอากาศปัจจุบันจากแหล่งข้อมูลภายนอก',
                navigator.onLine
                    ? 'โปรดตรวจสิทธิ์ Location และลองอัปเดตอีกครั้ง ระบบจะไม่ใช้ชื่อพื้นที่หรือข้อมูลอากาศเก่ามาแสดงแทน'
                    : 'ออฟไลน์อยู่ จึงไม่สามารถเรียกตำแหน่งย้อนกลับ แผนที่ หรือข้อมูลอากาศใหม่ได้ แต่หน้าเว็บส่วนอื่นยังใช้งานได้',
            );
        }

        function updateCardsUI(uv, temp, hum, aqi, weatherDescription = '', locationName = '') {
            let uvStatus = "ต่ำ", uvClass = "bg-emerald-50 text-emerald-600 border-emerald-100", uvBadgeClass = "bg-emerald-100 text-emerald-700", uvDesc = "รังสี UV ปลอดภัย";
            if (uv >= 3 && uv <= 5) { uvStatus = "ปานกลาง"; uvClass = "bg-yellow-50 text-yellow-600 border-yellow-100"; uvBadgeClass = "bg-yellow-100 text-yellow-700"; uvDesc = "เริ่มมีรังสี UV ควรทากันแดดเมื่อต้องออกแจ้ง"; }
            else if (uv >= 6 && uv <= 7) { uvStatus = "สูง"; uvClass = "bg-orange-50 text-orange-600 border-orange-100"; uvBadgeClass = "bg-orange-100 text-orange-700"; uvDesc = "รังสี UV สูง ควรทาครีมกันแดด SPF 50+ และสวมหมวก"; }
            else if (uv >= 8) { uvStatus = "สูงมาก"; uvClass = "bg-rose-50 text-rose-600 border-rose-100"; uvBadgeClass = "bg-rose-100 text-rose-700"; uvDesc = "รังสี UV สูงมาก เสี่ยงต่อผิวไหม้แดด ควรหลีกเลี่ยงแดดจัด"; }

            document.getElementById('card-uv-val').textContent = uv;
            const cardUvStatus = document.getElementById('card-uv-status');
            cardUvStatus.textContent = uvStatus;
            cardUvStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${uvClass}`;

            let tempStatus = "สบาย", tempClass = "bg-emerald-50 text-emerald-600 border-emerald-100", tempBadgeClass = "bg-emerald-100 text-emerald-700", tempDesc = "อุณหภูมิสบายตัว";
            if (temp > 32) { tempStatus = "ร้อน"; tempClass = "bg-orange-50 text-orange-600 border-orange-100"; tempBadgeClass = "bg-orange-100 text-orange-700"; tempDesc = "อากาศร้อน เช็ดเหงื่อป้องกันอุดตัน"; }
            else if (temp < 22) { tempStatus = "เย็น"; tempClass = "bg-blue-50 text-blue-600 border-blue-100"; tempBadgeClass = "bg-blue-100 text-blue-700"; tempDesc = "อากาศเย็น เติมความชุ่มชื้นผิว"; }

            const tempDisplay = Number(temp).toFixed(1);
            document.getElementById('card-temp-val').textContent = `${tempDisplay}°C`;
            const cardTempStatus = document.getElementById('card-temp-status');
            cardTempStatus.textContent = tempStatus;
            cardTempStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${tempClass}`;

            let humStatus = "ปกติ", humClass = "bg-emerald-50 text-emerald-600 border-emerald-100", humBadgeClass = "bg-emerald-100 text-emerald-700", humDesc = "ความชื้นสมดุล";
            if (hum > 70) { humStatus = "ค่อนข้างสูง"; humClass = "bg-blue-50 text-blue-600 border-blue-100"; humBadgeClass = "bg-blue-100 text-blue-700"; humDesc = "ความชื้นสูง ควรอยู่ในที่ระบายอากาศดี"; }
            else if (hum < 40) { humStatus = "แห้ง"; humClass = "bg-amber-50 text-amber-600 border-amber-100"; humBadgeClass = "bg-amber-100 text-amber-700"; humDesc = "อากาศแห้ง ควรเพิ่มความชุ่มชื้น"; }

            document.getElementById('card-humidity-val').textContent = `${hum}%`;
            const cardHumStatus = document.getElementById('card-humidity-status');
            cardHumStatus.textContent = humStatus;
            cardHumStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${humClass}`;

            let aqiStatus = "ดีมาก", aqiClass = "bg-emerald-50 text-emerald-600 border-emerald-100", aqiBadgeClass = "bg-emerald-100 text-emerald-700", aqiDesc = "อากาศสะอาด";
            if (aqi > 50 && aqi <= 100) { aqiStatus = "ปานกลาง"; aqiClass = "bg-yellow-50 text-yellow-600 border-yellow-100"; aqiBadgeClass = "bg-yellow-100 text-yellow-700"; aqiDesc = "มีฝุ่นสะสมปานกลาง ล้างหน้าหลังเข้าบ้าน"; }
            else if (aqi > 100) { aqiStatus = "มีผลกระทบ"; aqiClass = "bg-rose-50 text-rose-600 border-rose-100"; aqiBadgeClass = "bg-rose-100 text-rose-700"; aqiDesc = "ฝุ่นละอองสูง สวมหน้ากากและล้างหน้าให้สะอาด"; }

            document.getElementById('card-aqi-val').textContent = aqi;
            const cardAqiStatus = document.getElementById('card-aqi-status');
            cardAqiStatus.textContent = aqiStatus;
            cardAqiStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${aqiClass}`;

            const currentHour = new Date().getHours();
            const isDaytime = currentHour >= 6 && currentHour < 18;

            const timeBadge = document.getElementById('time-period-badge');
            const timeText = document.getElementById('time-period-text');

            if (isDaytime) {
                timeBadge.className = "px-3 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/40";
                timeText.textContent = "☀️ ช่วงเวลากลางวัน (Daytime)";
            } else {
                timeBadge.className = "px-3 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40";
                timeText.textContent = "🌙 ช่วงเวลากลางคืน (Nighttime)";
            }

            const timePeriodLabel = isDaytime ? "กลางวัน" : "กลางคืน";
            const areaText = locationName ? `สำหรับ ${locationName} ` : '';
            const weatherText = weatherDescription ? `${weatherDescription}, ` : '';
            document.getElementById('env-summary-text').textContent = `${areaText}สภาพอากาศโดยประมาณจากแหล่งข้อมูลปัจจุบัน (${timePeriodLabel}): ${weatherText}อุณหภูมิ ${tempDisplay}°C, ค่า UV อยู่ที่ ${uv} (${uvStatus}) และความชื้น ${hum}% (${humStatus}) สรุปคำแนะนำดูแลผิวทั่วไปดังนี้`;

            if (isDaytime) {
                document.getElementById('rec-1').textContent = uv >= 3 ? 'ทาครีมกันแดด SPF 30-50+ เป็นประจำก่อนออกแดด' : 'ทาครีมกันแดดเนื้อบางเบาเพื่อปกป้องผิว';
                document.getElementById('rec-2').textContent = temp > 30 ? 'สวมเสื้อผ้าแขนยาวระบายอากาศดี ป้องกันความร้อน' : 'สวมเสื้อผ้าปกคลุมผิวอย่างเหมาะสม';
                document.getElementById('rec-3').textContent = 'หลีกเลี่ยงแดดจัดและเตรียมหมวกหรือร่มกัน UV';
                document.getElementById('rec-4').textContent = 'จิบน้ำสะอาดอย่างน้อย 8 แก้ว เติมความชุ่มชื้นตลอดวัน';
            } else {
                document.getElementById('rec-1').textContent = 'ทำความสะอาดผิวหน้า (Double Cleansing) ล้างคราบฝุ่นละออง';
                document.getElementById('rec-2').textContent = hum < 50 ? 'ทา Night Cream หรือมอยส์เจอไรเซอร์เติมความชุ่มชื้น' : 'ทาบำรุงผิวสูตรบางเบา ไม่ให้อุดตันรูขุมขน';
                document.getElementById('rec-3').textContent = 'เปิดเครื่องฟอกอากาศและปิดหน้าต่างลดฝุ่นละอองสะสม';
                document.getElementById('rec-4').textContent = 'ดื่มน้ำ 1 แก้วก่อนนอน เพื่อฟื้นฟูเกราะป้องกันผิวตลอดคืน';
            }

            if (typeof lucide !== 'undefined') lucide.createIcons();

            liveEnvData.uv = { val: uv, status: uvStatus, title: "UV Index (ดัชนีรังสีอุลตราไวโอเลต)", badge: uvStatus, badgeClass: uvBadgeClass, iconBg: "bg-amber-100 text-amber-600", icon: "sun", desc: uvDesc };
            liveEnvData.temp = { val: `${tempDisplay}°C`, status: tempStatus, title: "อุณหภูมิอากาศโดยประมาณ (Temperature)", badge: tempStatus, badgeClass: tempBadgeClass, iconBg: "bg-orange-100 text-orange-600", icon: "thermometer", desc: `${tempDesc} ค่านี้มาจากกริดข้อมูลอากาศ จึงอาจไม่ตรงกับแอปหรือสถานีวัดอื่น` };
            liveEnvData.humidity = { val: `${hum}%`, status: humStatus, title: "ความชื้นสัมพัทธ์ (Humidity)", badge: humStatus, badgeClass: humBadgeClass, iconBg: "bg-blue-100 text-blue-600", icon: "droplets", desc: humDesc };
            liveEnvData.aqi = { val: aqi, status: aqiStatus, title: "ดัชนีคุณภาพอากาศ (AQI)", badge: aqiStatus, badgeClass: aqiBadgeClass, iconBg: "bg-emerald-100 text-emerald-600", icon: "wind", desc: aqiDesc };
        }

        // 🏥 ระบบค้นหาสถานพยาบาลและหมุดตำแหน่งโดยประมาณของผู้ใช้ 🏥
        function clearMapLocationConsent() {
            // Map consent is deliberately scoped to the currently open modal.
            // A previously acquired browser position may remain in memory for
            // the separate weather feature, but it must never be added to a
            // map/search URL without a fresh, explicit map opt-in.
            mapLocationConsent = false;
            mapGoogleMapsLocationConsent = false;
            document.getElementById('mapLocationConsentCheck').checked = false;
            document.getElementById('googleMapLocationConsentCheck').checked = false;
            document.getElementById('mapLocationButton').textContent = 'แสดงตำแหน่งปัจจุบันโดยประมาณบนแผนที่';
        }

        function mayShareLocationWithGoogleMaps() {
            return mapLocationConsent
                && mapGoogleMapsLocationConsent
                && document.getElementById('googleMapLocationConsentCheck')?.checked === true
                && Number.isFinite(currentLat)
                && Number.isFinite(currentLng);
        }

        function openMapModal(category = 'dermatologist') {
            clearMapLocationConsent();
            setMapLocationStatus('เลือกคำค้นหาได้โดยไม่ใช้ตำแหน่ง หรือยืนยันด้านล่างเพื่อแสดงหมุดตำแหน่งล่าสุดของคุณ');
            filterMapSearch(category);
            showAccessibleModal('mapModal', '#customSearchInput');
        }

        function filterMapSearch(category) {
            let queryText = "คลินิกโรคผิวหนัง";
            const btnDerm = document.getElementById('mapBtnDerm');
            const btnHosp = document.getElementById('mapBtnHosp');
            const btnPharm = document.getElementById('mapBtnPharm');

            btnDerm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";
            btnHosp.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";
            btnPharm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";

            if (category === 'dermatologist') {
                queryText = "คลินิกโรคผิวหนัง หมอผิวหนัง";
                btnDerm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            } else if (category === 'hospital') {
                queryText = "แผนกผิวหนัง ศูนย์โรคผิวหนัง โรงพยาบาล";
                btnHosp.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            } else if (category === 'pharmacy') {
                queryText = "ร้านขายยา ยาทาผิวหนัง";
                btnPharm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            }

            executeSearchWithQuery(queryText);
        }

        function executeCustomSearch() {
            const searchInput = document.getElementById('customSearchInput').value.trim();
            if (searchInput !== '') {
                executeSearchWithQuery(searchInput + " โรคผิวหนัง คลินิก โรงพยาบาล");
            }
        }

        function handleSearchKeyPress(event) {
            if (event.key === 'Enter') {
                executeCustomSearch();
            }
        }

        function buildOpenStreetMapEmbedUrl(lat, lng) {
            const markerLat = roundedCoordinate(lat);
            const markerLng = roundedCoordinate(lng);
            const span = 0.012;
            const bbox = [markerLng - span, markerLat - span, markerLng + span, markerLat + span]
                .map((coordinate) => coordinate.toFixed(4))
                .join('%2C');
            return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${markerLat.toFixed(4)}%2C${markerLng.toFixed(4)}`;
        }

        function showCurrentLocationMarker() {
            const markerLat = roundedCoordinate(currentLat);
            const markerLng = roundedCoordinate(currentLng);
            const nearbyName = currentLocationMeta.approximateName;
            const nearbyLabel = nearbyName ? `พื้นที่ใกล้เคียง: ${nearbyName}` : 'ตำแหน่งโดยประมาณจากอุปกรณ์';
            document.getElementById('coords-text').textContent = `หมุดตำแหน่งปัจจุบันโดยประมาณ — ${nearbyLabel}`;
            loadMapFrame(buildOpenStreetMapEmbedUrl(markerLat, markerLng));
            const externalButton = document.getElementById('btnExternalNav');
            const externalButtonText = document.getElementById('btnExternalNavText');
            if (mayShareLocationWithGoogleMaps()) {
                externalButton.href = `https://www.google.com/maps/search/?api=1&query=${markerLat.toFixed(4)}%2C${markerLng.toFixed(4)}`;
                externalButtonText.textContent = 'เปิดตำแหน่งใน Google Maps';
            } else {
                externalButton.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lastMapQuery)}`;
                externalButtonText.textContent = 'ค้นหาใน Google Maps';
                setMapLocationStatus(`แสดงหมุดผ่าน OpenStreetMap แล้ว (${formatGpsAccuracy(currentLocationMeta.accuracyMeters)}) Google Maps ยังไม่ได้รับพิกัดของคุณ`);
            }
        }

        function executeSearchWithQuery(queryText) {
            lastMapQuery = queryText;
            const hasMapLocation = mapLocationConsent && Number.isFinite(currentLat) && Number.isFinite(currentLng);
            const shareWithGoogle = mayShareLocationWithGoogleMaps();
            const locationStatus = shareWithGoogle
                ? ' — Google Maps จัดกึ่งกลางผลค้นหาตามพิกัดโดยประมาณที่คุณยินยอม'
                : hasMapLocation
                    ? ' — มีหมุด OpenStreetMap โดยประมาณ แต่ Google Maps ค้นหาโดยไม่ใช้ตำแหน่ง'
                    : ' — ค้นหาโดยไม่ใช้ตำแหน่งของคุณ';
            document.getElementById('coords-text').textContent = `ค้นหาคำสำคัญ: ${queryText}${locationStatus}`;

            if (!navigator.onLine) {
                showMapFrameFallback('ออฟไลน์อยู่ จึงยังโหลดแผนที่หรือผลค้นหาสถานพยาบาลไม่ได้');
                document.getElementById('btnExternalNav').href = '#';
                return;
            }

            const locationQuery = shareWithGoogle ? `&ll=${roundedCoordinate(currentLat)},${roundedCoordinate(currentLng)}&z=13` : '';
            const mapUrl = `https://maps.google.com/maps?q=${encodeURIComponent(queryText)}${locationQuery}&output=embed`;
            loadMapFrame(mapUrl);
            document.getElementById('btnExternalNav').href = shareWithGoogle
                ? `https://www.google.com/maps/search/${encodeURIComponent(queryText)}/@${roundedCoordinate(currentLat)},${roundedCoordinate(currentLng)},14z`
                : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(queryText)}`;
            document.getElementById('btnExternalNavText').textContent = 'ค้นหาใน Google Maps';
        }

        function useCurrentLocationForMap() {
            if (!window.isSecureContext) {
                const message = insecureLocationContextMessage();
                document.getElementById('coords-text').textContent = message;
                setMapLocationStatus(message, true);
                return;
            }
            if (!navigator.onLine) {
                const message = 'ออฟไลน์อยู่ จึงไม่สามารถเรียกแผนที่ปัจจุบันได้ โปรดเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่';
                document.getElementById('coords-text').textContent = message;
                showMapFrameFallback(message);
                setMapLocationStatus(message, true);
                return;
            }
            if (!navigator.geolocation) {
                const message = 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง จึงค้นหาโดยไม่ใช้ตำแหน่ง';
                document.getElementById('coords-text').textContent = message;
                setMapLocationStatus(message, true);
                return;
            }
            if (!document.getElementById('mapLocationConsentCheck').checked) {
                setMapLocationStatus('โปรดยืนยันความยินยอมด้านบนก่อนขอตำแหน่งจากเบราว์เซอร์', true);
                return;
            }

            // Capture the Google-specific choice before the browser GPS prompt.
            // It prevents a coordinate obtained for OpenStreetMap from being
            // sent to Google merely because the checkbox is ticked later.
            const wantsGoogleMapsLocation = document.getElementById('googleMapLocationConsentCheck').checked === true;

            document.getElementById('coords-text').textContent = 'กำลังขอตำแหน่งล่าสุดจากอุปกรณ์';
            setMapLocationStatus('กำลังขอตำแหน่งใหม่ โดยไม่ใช้พิกัดที่ค้างอยู่ในหน้าเว็บ');
            // A map request is a separate consent action. Always ask for a fresh
            // browser position instead of reusing an earlier weather/map reading.
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    saveFreshBrowserLocation(position);
                    mapLocationConsent = true;
                    mapGoogleMapsLocationConsent = wantsGoogleMapsLocation;
                    document.getElementById('mapLocationButton').textContent = 'อัปเดตหมุดตำแหน่งปัจจุบันอีกครั้ง';
                    currentLocationMeta.approximateName = await fetchApproximateLocationName(currentLat, currentLng).catch(() => '');
                    showCurrentLocationMarker();
                    if (mayShareLocationWithGoogleMaps()) {
                        setMapLocationStatus(`แสดงหมุดพิกัดโดยประมาณแล้ว (${formatGpsAccuracy(currentLocationMeta.accuracyMeters)}) และอนุญาตให้ Google Maps ใช้พิกัดสำหรับค้นหา`);
                    }
                },
                (error) => {
                    const message = `${locationErrorMessage(error)} — จึงค้นหาโดยไม่ใช้ตำแหน่ง`;
                    document.getElementById('coords-text').textContent = message;
                    setMapLocationStatus(message, true);
                },
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        }

        function closeMapModal() {
            clearMapLocationConsent();
            // Stop an embedded third-party map once the dialog is dismissed so
            // it cannot retain a location-bearing URL in this page session.
            const frame = document.getElementById('googleMapIframe');
            if (frame) frame.src = '';
            hideAccessibleModal('mapModal');
        }

        function openEnvDetailModal(type) {
            const data = liveEnvData[type];
            if (!data) return;
            document.getElementById('envModalTitle').textContent = data.title;
            document.getElementById('envModalValue').textContent = `${data.val} (${data.status})`;
            const badge = document.getElementById('envModalBadge');
            badge.textContent = data.badge;
            badge.className = `inline-block text-[11px] font-bold px-2.5 py-0.5 rounded-full mt-1 ${data.badgeClass}`;
            const iconDiv = document.getElementById('envModalIcon');
            iconDiv.className = `p-3 rounded-2xl ${data.iconBg}`;
            iconDiv.innerHTML = `<i data-lucide="${data.icon}" class="w-6 h-6"></i>`;
            document.getElementById('envModalDesc').textContent = data.desc;
            if (typeof lucide !== 'undefined') lucide.createIcons();
            showAccessibleModal('envDetailModal', '[data-modal-close]');
        }
        function closeEnvDetailModal() { hideAccessibleModal('envDetailModal'); }

        function switchForm(type) {
            const formLogin = document.getElementById('formLogin');
            const formRegister = document.getElementById('formRegister');
            const btnTabLogin = document.getElementById('btnTabLogin');
            const btnTabRegister = document.getElementById('btnTabRegister');

            if (!formLogin || !formRegister || !btnTabLogin || !btnTabRegister) return;

            if (type === 'login') {
                formLogin.classList.remove('hidden');
                formRegister.classList.add('hidden');
                btnTabLogin.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all bg-white text-slate-900 shadow-sm";
                btnTabRegister.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all text-slate-500 hover:text-slate-900";
                btnTabLogin.setAttribute('aria-selected', 'true');
                btnTabRegister.setAttribute('aria-selected', 'false');
            } else {
                formLogin.classList.add('hidden');
                formRegister.classList.remove('hidden');
                btnTabLogin.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all text-slate-500 hover:text-slate-900";
                btnTabRegister.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all bg-white text-teal-600 shadow-sm";
                btnTabLogin.setAttribute('aria-selected', 'false');
                btnTabRegister.setAttribute('aria-selected', 'true');
            }
        }

        function setAccountStatus(message, tone = 'info') {
            const status = document.getElementById('accountStatus');
            if (!status) return;
            const styles = {
                info: 'border-teal-200 bg-teal-50 text-teal-900',
                success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
                error: 'border-rose-200 bg-rose-50 text-rose-900',
                warning: 'border-amber-200 bg-amber-50 text-amber-900',
            };
            status.className = `mt-5 rounded-xl border px-4 py-3 text-center text-xs leading-relaxed ${styles[tone] || styles.info}`;
            status.textContent = message;
            status.focus();
        }

        function setAccountBusy(form, isBusy) {
            const submit = form?.querySelector('button[type="submit"]');
            if (!submit) return;
            if (!submit.dataset.defaultLabel) submit.dataset.defaultLabel = submit.textContent;
            submit.disabled = isBusy;
            submit.classList.toggle('opacity-60', isBusy);
            submit.classList.toggle('cursor-wait', isBusy);
            submit.textContent = isBusy ? 'กำลังดำเนินการ…' : submit.dataset.defaultLabel;
        }

        function showAccountSession(user) {
            const formLogin = document.getElementById('formLogin');
            const formRegister = document.getElementById('formRegister');
            const tabs = document.getElementById('btnTabLogin')?.parentElement;
            const panel = document.getElementById('accountSessionPanel');
            const name = document.getElementById('accountSessionName');
            if (!formLogin || !formRegister || !tabs || !panel || !name) return;
            formLogin.classList.add('hidden');
            formRegister.classList.add('hidden');
            tabs.classList.add('hidden');
            name.textContent = `ยินดีต้อนรับ ${user.name} (${user.email})`;
            panel.classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function showAccountForms() {
            const formLogin = document.getElementById('formLogin');
            const panel = document.getElementById('accountSessionPanel');
            const tabs = document.getElementById('btnTabLogin')?.parentElement;
            panel?.classList.add('hidden');
            tabs?.classList.remove('hidden');
            formLogin?.reset();
            document.getElementById('formRegister')?.reset();
            switchForm('login');
        }

        async function accountRequest(path, body) {
            const response = await fetch(path, {
                method: body ? 'POST' : 'GET',
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                credentials: 'same-origin',
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'ไม่สามารถเชื่อมต่อระบบบัญชีได้ในขณะนี้');
            return data;
        }

        async function submitAccountForm(event) {
            event.preventDefault();
            const form = event.currentTarget;
            const isRegister = form.id === 'formRegister';
            const email = form.querySelector('input[name="email"]')?.value || '';
            const password = form.querySelector('input[name="password"]')?.value || '';
            const body = isRegister
                ? {
                    name: document.getElementById('registerName')?.value || '',
                    email,
                    password,
                    termsAccepted: Boolean(document.getElementById('registerTerms')?.checked),
                }
                : { email, password };
            setAccountBusy(form, true);
            try {
                const result = await accountRequest(`/api/account/${isRegister ? 'register' : 'login'}`, body);
                form.reset();
                showAccountSession(result.user);
                setAccountStatus(result.message || 'เข้าสู่ระบบเรียบร้อยแล้ว', 'success');
            } catch (error) {
                setAccountStatus(error.message || 'ไม่สามารถดำเนินการได้ในขณะนี้', 'error');
            } finally {
                setAccountBusy(form, false);
            }
        }

        async function restoreAccountSession() {
            try {
                const result = await accountRequest('/api/account/me');
                if (result.user) showAccountSession(result.user);
            } catch (error) {
                if (/กำลังตั้งค่า/.test(error.message || '')) setAccountStatus(error.message, 'warning');
            }
        }

        async function logoutAccount() {
            const button = document.getElementById('logoutButton');
            if (button) {
                button.disabled = true;
                button.textContent = 'กำลังออกจากระบบ…';
            }
            try {
                await accountRequest('/api/account/logout', {});
                showAccountForms();
                setAccountStatus('ออกจากระบบเรียบร้อยแล้ว', 'info');
            } catch (error) {
                setAccountStatus(error.message || 'ไม่สามารถออกจากระบบได้ในขณะนี้', 'error');
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = 'ออกจากระบบ';
                }
            }
        }
