/**
 * Lampa Shikimori Plugin Entrypoint
 */
(function () {
    'use strict';

    function sendLog(msg) {
        try {
            console.log('[Shikimori]', msg);
        } catch (e) {}
    }
    window.shikiSendLog = sendLog;

    if (window.addEventListener) {
        window.addEventListener('error', function (event) {
            sendLog('GLOBAL ERROR: ' + (event.message || event) + ' (' + event.filename + ':' + event.lineno + ')');
        });
    }

    function startPlugin() {
        if (window.shikimori_plugin_loaded) return;
        window.shikimori_plugin_loaded = true;

        sendLog('Initializing plugin...');

        ShikiPlayer.init();
        ShikiUI.init();
        ShikiSettings.init();

        // Refresh rates cache if authorized. The access token lives ~24h, so ask
        // the relay to renew it with the refresh token once per Lampa start.
        if (ShikiApi.isAuthorized()) {
            var cur = ShikiApi.getUser();
            sendLog('Authorized as ' + (cur.nickname || cur.id));

            var loadRates = function () {
                ShikiApi.loadAllUserRates(function () {
                    sendLog('User rates cache updated successfully');
                }, function () {});
            };

            var ratesAt = Number(Lampa.Storage.get('shikimori_rates_at', 0)) || 0;
            var ratesFresh = Date.now() - ratesAt < 15 * 60 * 1000;
            var loadRatesIfNeeded = function () {
                if (!ratesFresh) loadRates();
            };

            var refreshToken = Lampa.Storage.get('shikimori_refresh_token', '');
            if (refreshToken && typeof ShikiQrAuth !== 'undefined' && ShikiQrAuth.refresh) {
                ShikiQrAuth.refresh(function (ok) {
                    if (ok) sendLog('Access token refreshed');
                    loadRatesIfNeeded();
                });
            } else {
                loadRatesIfNeeded();
            }
        } else {
            sendLog('Guest mode (not logged in)');
        }

        sendLog('Plugin ready and registered!');
    }

    function isLampaReady() {
        try {
            return !!(window.appready || (window.Lampa && window.Lampa.Activity && window.Lampa.Storage));
        } catch (e) {
            return false;
        }
    }

    function waitApp() {
        if (isLampaReady()) {
            sendLog('Lampa is already ready on script load!');
            startPlugin();
            return;
        }

        sendLog('Script loaded, polling for Lampa readiness...');
        var checks = 0;
        var timer = setInterval(function () {
            try {
                checks++;
                if (isLampaReady()) {
                    clearInterval(timer);
                    sendLog('Lampa readiness detected (checks=' + checks + ')');
                    startPlugin();
                } else if (checks % 30 === 0) {
                    sendLog('Polling (checks=' + checks + ', Lampa=' + !!window.Lampa + ')');
                } else if (checks > 600) {
                    clearInterval(timer);
                    sendLog('Timeout waiting for Lampa after 60s');
                }
            } catch (err) {
                sendLog('Interval error: ' + err);
            }
        }, 100);
    }
    waitApp();
})();
