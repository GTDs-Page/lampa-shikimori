/**
 * Settings and Authentication Modal for Lampa Shikimori Plugin
 */
var ShikiSettings = (function () {
    function init() {
        registerSettings();
    }

    function registerSettings() {
        if (!window.Lampa) return;

        // If SettingsApi exists
        if (Lampa.SettingsApi) {
            if (Lampa.Params && Lampa.Params.select) {
                Lampa.Params.select('shikimori_preferred_voice', '', '');
                Lampa.Params.select('shikimori_account_btn', '', '');
            }

            Lampa.SettingsApi.addComponent({
                component: 'shikimori_settings',
                name: 'Shikimori',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>'
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_qr_login',
                    type: 'button',
                    values: '',
                    default: ''
                },
                field: {
                    name: 'Вход по QR-коду',
                    description: 'Отсканируйте QR телефоном и разрешите доступ — токен придёт на телевизор автоматически.'
                },
                onRender: function (item) {
                    item.on('hover:enter', function () {
                        ShikiQrAuth.start();
                    });
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_account_btn',
                    type: 'button',
                    values: '',
                    default: ''
                },
                field: {
                    name: 'Аккаунт Shikimori',
                    description: getAccountStatusText()
                },
                onRender: function (item) {
                    item.on('hover:enter', function () {
                        openAuthModal();
                    });
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_token_btn',
                    type: 'button',
                    values: '',
                    default: ''
                },
                field: {
                    name: 'Токен Shikimori (OAuth)',
                    description: getTokenStatusText()
                },
                onRender: function (item) {
                    item.on('hover:enter', function () {
                        ShikiKeyboard.open({
                            title: 'Токен Shikimori (OAuth)',
                            value: Lampa.Storage.get('shikimori_token', '') || '',
                            onDone: function (value) {
                                saveToken(value);
                            }
                        });
                    });
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_auto_sync',
                    type: 'trigger',
                    default: true
                },
                field: {
                    name: 'Автоматически отмечать серии',
                    description: 'Отправлять прогресс просмотра на Shikimori при завершении серии'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_sync_percent',
                    type: 'select',
                    values: {
                        '70': '70% серии',
                        '80': '80% серии (рекомендуется)',
                        '90': '90% серии',
                        '98': 'Конец серии'
                    },
                    default: '80'
                },
                field: {
                    name: 'Порог зачёта серии',
                    description: 'При каком проценте просмотра серия считается просмотренной'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_preferred_voice',
                    type: 'input',
                    values: '',
                    default: '',
                    placeholder: 'Например: AniLibria или Studio Band'
                },
                field: {
                    name: 'Любимая озвучка',
                    description: 'Автоматически выбирать указанную студию перевода'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'shikimori_settings',
                param: {
                    name: 'shikimori_domain',
                    type: 'select',
                    values: {
                        'https://shikimori.io': 'shikimori.io (Рекомендуемый)',
                        'https://shikimori.me': 'shikimori.me (Зеркало)',
                        'https://shikimori.one': 'shikimori.one (Резерв)'
                    },
                    default: 'https://shikimori.io'
                },
                field: {
                    name: 'Зеркало Shikimori',
                    description: 'Домен для обращений к API'
                }
            });
        }
    }

    function getAccountStatusText() {
        var user = ShikiApi.getUser();
        if (user && user.nickname) {
            return 'Авторизован как: ' + user.nickname;
        }
        return 'Нажмите для входа в аккаунт';
    }

    function getTokenStatusText() {
        var token = (ShikiApi.getToken && ShikiApi.getToken()) || '';
        return token
            ? 'Токен задан (действует около суток, без автообновления)'
            : 'Ручной ввод на ~1 сутки. Для постоянного входа используйте QR-код.';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getUserAvatar(user) {
        if (!user) return '';
        var image = user.image || {};
        // Shikimori returns x160/x148/x80/x64/x48/x32/x16 (there is no x96,
        // which the old code used, so the avatar silently disappeared).
        return image.x160 || image.x148 || image.x96 || image.x80 || image.x64 ||
            image.x48 || user.avatar || image.preview || image.original || '';
    }

    function saveToken(value) {
        var token = (value || '').trim();

        if (!token) {
            Lampa.Storage.set('shikimori_token', '');
            Lampa.Noty.show('Токен удалён');
            return;
        }

        Lampa.Storage.set('shikimori_token', token);
        Lampa.Noty.show('Проверка токена...');

        ShikiApi.whoami(function (user) {
            Lampa.Noty.show('Токен принят: ' + (user.nickname || user.id), { time: 4000 });
            ShikiApi.loadAllUserRates(function () {}, function () {});
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.send('shikimori_user_updated', {});
            }
        }, function () {
            // Never keep a rejected token: every API call would get 401.
            Lampa.Storage.set('shikimori_token', '');
            Lampa.Noty.show('Токен не принят Shikimori', { time: 4000 });
        });
    }

    function promptLoginKeyboard() {
        if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
            ShikiKeyboard.open({
                title: 'Введите никнейм на Shikimori',
                value: '',
                onDone: function (val) {
                    processLoginValue(val);
                }
            });
            return;
        }

        if (window.Lampa && Lampa.Input) {
            Lampa.Input.edit({
                title: 'Введите ваш никнейм на Shikimori',
                value: '',
                free: true,
                nosave: true,
                nomic: true
            }, function (val) {
                processLoginValue(val);
            });
        }
    }

    function processLoginValue(val) {
        if (!val || !val.trim()) return;
        val = val.trim();
        Lampa.Noty.show('Поиск «' + val + '» на Shikimori...');
        ShikiApi.loginByNickname(val, function (userData) {
            Lampa.Noty.show('Добро пожаловать, ' + (userData.nickname || val) + '!', { time: 3000 });
            ShikiApi.loadAllUserRates(function () {
                if (window.Lampa && Lampa.Listener) {
                    Lampa.Listener.send('shikimori_user_updated', {});
                }
                if (window.Lampa && Lampa.Activity) {
                    Lampa.Activity.replace();
                }
            });
        }, function () {
            // If nickname lookup fails, try as token
            Lampa.Storage.set('shikimori_token', val);
            ShikiApi.whoami(function (userData) {
                Lampa.Noty.show('Добро пожаловать, ' + (userData.nickname || val) + '!', { time: 3000 });
                ShikiApi.loadAllUserRates(function () {
                    if (window.Lampa && Lampa.Listener) {
                        Lampa.Listener.send('shikimori_user_updated', {});
                    }
                    if (window.Lampa && Lampa.Activity) {
                        Lampa.Activity.replace();
                    }
                });
            }, function () {
                Lampa.Storage.set('shikimori_token', '');
                Lampa.Noty.show('Пользователь «' + val + '» не найден на Shikimori', { time: 4000 });
            });
        });
    }

    function enabledControllerName() {
        try {
            if (window.Lampa && Lampa.Controller && Lampa.Controller.enabled) {
                var active = Lampa.Controller.enabled();
                return active ? active.name : null;
            }
        } catch (e) {}
        return null;
    }

    function restoreController(name) {
        if (!name) return;
        try {
            if (window.Lampa && Lampa.Controller && enabledControllerName() !== name) {
                Lampa.Controller.toggle(name);
            }
        } catch (e) {}
    }

    function openAuthModal() {
        var user = ShikiApi.getUser();

        if (!user) {
            promptLoginKeyboard();
            return;
        }

        // Modal.close() does not restore the controller by itself; without this
        // the D-pad stays on the destroyed "modal" controller after closing the
        // profile from the Settings screen.
        var previousController = enabledControllerName();

        var avatar = ShikiApi.fixImageUrl(getUserAvatar(user));
        var nickname = escapeHtml(user.nickname || '');
        var initial = escapeHtml((user.nickname || '?').charAt(0).toUpperCase());

        var avatarHtml = avatar
            ? '<img class="shiki-auth-avatar" src="' + escapeHtml(avatar) + '" ' +
                'style="width: 72px; height: 72px; border-radius: 50%; margin-bottom: 0.5em; object-fit: cover;" ' +
                'onerror="this.style.display=\'none\';this.parentNode.querySelector(\'.shiki-auth-avatar-fallback\').style.display=\'flex\';" />' +
              '<div class="shiki-auth-avatar-fallback" style="display: none; width: 72px; height: 72px; border-radius: 50%; ' +
                'margin: 0 auto 0.5em; align-items: center; justify-content: center; background: #2ecc71; color: #111; ' +
                'font-size: 1.8em; font-weight: bold;">' + initial + '</div>'
            : '<div class="shiki-auth-avatar-fallback" style="display: flex; width: 72px; height: 72px; border-radius: 50%; ' +
                'margin: 0 auto 0.5em; align-items: center; justify-content: center; background: #2ecc71; color: #111; ' +
                'font-size: 1.8em; font-weight: bold;">' + initial + '</div>';

        var content = $(`
            <div class="shiki-auth-modal" style="padding: 1.5em; text-align: center; max-width: 480px; margin: 0 auto;">
                <div style="margin-bottom: 1.2em;">
                    ${avatarHtml}
                    <div style="font-size: 1.3em; font-weight: bold; color: #fff;">${nickname}</div>
                    <div style="color: #2ecc71; margin-top: 0.3em; font-size: 0.9em;">✓ Аккаунт подключен к Shikimori</div>
                </div>
                <div style="color: #aaa; font-size: 0.85em; line-height: 1.4;">
                    Списки «Смотрю», «В планах» и история серий синхронизируются с вашим профилем.
                </div>
            </div>
        `);

        var buttons = [
            {
                name: 'Сменить никнейм',
                onSelect: function () {
                    Lampa.Modal.close();
                    restoreController(previousController);
                    promptLoginKeyboard();
                }
            },
            {
                name: 'Выйти из аккаунта',
                onSelect: function () {
                    ShikiApi.logout();
                    Lampa.Modal.close();
                    restoreController(previousController);
                    Lampa.Noty.show('Вы вышли из Shikimori');
                    if (window.Lampa && Lampa.Activity) {
                        Lampa.Activity.replace();
                    }
                }
            },
            {
                name: 'Закрыть',
                onSelect: function () {
                    Lampa.Modal.close();
                    restoreController(previousController);
                }
            }
        ];

        Lampa.Modal.open({
            title: 'Профиль Shikimori',
            html: content,
            buttons: buttons,
            onBack: function () {
                Lampa.Modal.close();
                restoreController(previousController);
            }
        });
    }

    return {
        init: init,
        openAuthModal: openAuthModal
    };
})();
