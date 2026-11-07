/**
 * Shikimori login by QR code.
 *
 * The TV asks the relay for a session, shows a QR with the phone URL and polls
 * the relay. The phone opens Shikimori, authorizes the OAuth app and the relay
 * hands the access token back to the TV. No typing on the remote.
 */
var ShikiQrAuth = (function () {
    'use strict';

    var DEFAULT_BASE = 'https://vechwzycaplsjabenhuz.supabase.co/functions/v1/shikimori-auth';
    var POLL_MS = 2000;
    var TIMEOUT_MS = 5 * 60 * 1000;
    var currentBase = null;
    var refreshing = false;
    var refreshQueue = [];

    function normalize(url) {
        return (url || '').replace(/\/+$/, '');
    }

    function candidates() {
        var list = [];
        var custom = '';
        try {
            custom = (Lampa.Storage.get('shikimori_qr_base', '') || '').trim();
        } catch (e) {}
        if (custom) list.push(normalize(custom));
        list.push(normalize(DEFAULT_BASE));

        var unique = [];
        for (var i = 0; i < list.length; i++) {
            if (unique.indexOf(list[i]) === -1) unique.push(list[i]);
        }
        return unique;
    }

    var pollTimer = null;
    var timeoutTimer = null;
    var modalOpen = false;
    var session = null;
    var previousController = null;

    function controllerName() {
        try {
            if (window.Lampa && Lampa.Controller && Lampa.Controller.enabled) {
                var active = Lampa.Controller.enabled();
                return active ? active.name : null;
            }
        } catch (e) {}
        return null;
    }

    function restoreController() {
        var name = previousController;
        previousController = null;
        if (!name) return;
        try {
            if (Lampa.Controller && Lampa.Controller.toggle) Lampa.Controller.toggle(name);
        } catch (e) {}
    }

    function errorMessage(xhr, status, err) {
        var message = err || status || 'сеть';
        try {
            var body = xhr.responseJSON;
            if (!body && xhr.responseText) body = JSON.parse(xhr.responseText);
            if (body && body.error) message = body.error;
        } catch (e) {}
        return message;
    }

    function request(method, path, body, success, error) {
        var bases = currentBase ? [currentBase] : candidates();
        var index = 0;

        function tryNext() {
            if (index >= bases.length) {
                if (error) error('сервер QR-входа недоступен');
                return;
            }

            var base = bases[index++];
            $.ajax({
                url: base + path,
                type: method,
                contentType: body ? 'application/json' : undefined,
                data: body ? JSON.stringify(body) : undefined,
                dataType: 'json',
                cache: false,
                timeout: 8000,
                success: function (data) {
                    currentBase = base;
                    if (success) success(data);
                },
                error: function (xhr, status, err) {
                    var code = xhr ? xhr.status : 0;
                    // Transport error or a host without the relay: try the next
                    // candidate. A real 4xx from a live relay is an answer.
                    if (code === 0 || code === 404 || code === 502 || code === 503) {
                        tryNext();
                        return;
                    }
                    if (error) error(errorMessage(xhr, status, err));
                }
            });
        }

        tryNext();
    }

    function api(path, success, error) {
        request('GET', path, null, success, error);
    }

    function stop() {
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        pollTimer = null;
        timeoutTimer = null;
        session = null;
    }

    function closeModal() {
        stop();
        if (!modalOpen) return;
        modalOpen = false;
        try {
            Lampa.Modal.close();
        } catch (e) {}
        // Modal.close() only removes the DOM; without this the D-pad stays on
        // the destroyed "modal" controller and the settings page freezes.
        restoreController();
    }

    function start() {
        if (pollTimer) return;
        currentBase = null;

        Lampa.Noty.show('Подготовка QR-кода...');

        api('?action=new', function (data) {
            if (!data || !data.sid || !data.key || !data.qr) {
                Lampa.Noty.show('Сервер QR-авторизации не настроен', { time: 5000 });
                return;
            }

            session = data;
            showModal(data);
            pollTimer = setInterval(poll, POLL_MS);
            timeoutTimer = setTimeout(function () {
                closeModal();
                Lampa.Noty.show('Время ожидания QR-входа истекло', { time: 5000 });
            }, TIMEOUT_MS);
        }, function (message) {
            Lampa.Noty.show('QR-вход недоступен: ' + message, { time: 6000 });
        });
    }

    function showModal(data) {
        var html = $(
            '<div class="shiki-qr" style="text-align:center;padding:0.4em 0.6em 0.2em;">' +
                '<div style="font-size:1.15em;font-weight:600;margin-bottom:0.7em;">Отсканируйте QR-код телефоном</div>' +
                '<img class="shiki-qr__img" src="' + data.qr + '" ' +
                    'style="width:300px;height:300px;background:#fff;padding:10px;border-radius:14px;' +
                    'box-shadow:0 8px 24px rgba(0,0,0,.55);" />' +
                '<div style="margin-top:0.85em;color:#aab0b8;font-size:0.9em;line-height:1.45;">' +
                    'Откроется Shikimori — войдите и разрешите доступ.<br>' +
                    'Телевизор получит токен автоматически.' +
                '</div>' +
                '<div class="shiki-qr__status" style="margin-top:0.7em;color:#2ecc71;font-size:0.9em;">' +
                    'Ожидание подтверждения...' +
                '</div>' +
            '</div>'
        );

        modalOpen = true;
        previousController = controllerName();
        Lampa.Modal.open({
            title: 'Вход в Shikimori по QR',
            html: html,
            buttons: [{
                name: 'Отмена',
                onSelect: function () {
                    closeModal();
                }
            }],
            onBack: function () {
                closeModal();
            }
        });
    }

    function poll() {
        if (!session) return;

        // POST body instead of ?sid=&key=: query strings end up in nginx and
        // systemd logs, and the key must not leak there.
        request('POST', '?action=status', { sid: session.sid, key: session.key }, function (data) {
            if (!data) return;

            if (data.status === 'ok' && data.access_token) {
                stop();
                if (modalOpen) {
                    modalOpen = false;
                    try { Lampa.Modal.close(); } catch (e) {}
                }
                restoreController();
                applyToken(data);
                return;
            }

            if (data.status === 'error') {
                closeModal();
                Lampa.Noty.show('Не удалось войти: ' + (data.error || 'ошибка Shikimori'), { time: 5000 });
                return;
            }

            if (data.status === 'expired' || data.status === 'forbidden') {
                closeModal();
                Lampa.Noty.show('QR-код устарел, попробуйте снова', { time: 5000 });
            }
        }, function () {
            // Network hiccup: keep polling until the timeout fires.
        });
    }

    function storeToken(data) {
        Lampa.Storage.set('shikimori_token', data.access_token || '');
        if (data.refresh_token) {
            Lampa.Storage.set('shikimori_refresh_token', data.refresh_token);
        }
        Lampa.Storage.set('shikimori_token_at', Date.now());
        Lampa.Storage.set('shikimori_token_expires', parseInt(data.expires_in, 10) || 0);
    }

    function applyToken(data) {
        storeToken(data);

        ShikiApi.whoami(function (user) {
            Lampa.Noty.show('Shikimori: ' + (user.nickname || user.id), { time: 4000 });
            ShikiApi.loadAllUserRates(function () {}, function () {});
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.send('shikimori_user_updated', {});
            }
            updateAccountText(user);
        }, function () {
            // Do not keep a token Shikimori rejected: every later request would
            // come back 401 and the user would have no obvious way to recover.
            Lampa.Storage.set('shikimori_token', '');
            Lampa.Storage.set('shikimori_refresh_token', '');
            Lampa.Storage.set('shikimori_user', null);
            Lampa.Noty.show('Токен не принят Shikimori, войдите заново', { time: 5000 });
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.send('shikimori_user_updated', {});
            }
        });
    }

    /**
     * Refresh the access token through the relay (the client secret never
     * leaves the server). Single-flight: many 401s at once must not start many
     * refresh requests, or Shikimori may rotate the refresh token under us.
     */
    function refresh(callback) {
        if (refreshing) {
            if (callback) refreshQueue.push(callback);
            return;
        }

        var token = (Lampa.Storage.get('shikimori_refresh_token', '') || '').trim();
        if (!token) {
            if (callback) callback(false);
            return;
        }

        refreshing = true;

        function finish(ok) {
            refreshing = false;
            if (callback) callback(ok);

            var queue = refreshQueue;
            refreshQueue = [];
            for (var i = 0; i < queue.length; i++) queue[i](ok);
        }

        request('POST', '?action=refresh', { refresh_token: token }, function (data) {
            var ok = !!(data && data.status === 'ok' && data.access_token);
            if (ok) storeToken(data);
            finish(ok);
        }, function () {
            finish(false);
        });
    }

    function updateAccountText(user) {
        try {
            $('.settings-param[data-name="shikimori_account_btn"] .settings-param__descr')
                .text('Авторизован как: ' + (user.nickname || user.id));
        } catch (e) {}
    }

    return {
        start: start,
        stop: stop,
        refresh: refresh
    };
})();
