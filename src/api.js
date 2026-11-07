/**
 * Shikimori API Client for Lampa
 */
var ShikiApi = (function () {
    function getDomain() {
        var d = Lampa.Storage.get('shikimori_domain', 'https://shikimori.io');
        return d.replace(/\/+$/, '');
    }

    function getToken() {
        return String(Lampa.Storage.get('shikimori_token', '') || '').trim();
    }

    function getUser() {
        return Lampa.Storage.get('shikimori_user', null);
    }

    function getHeaders(extraHeaders) {
        var h = {
            'User-Agent': 'Lampa-Shikimori-Plugin/2.0',
            'Accept': 'application/json'
        };
        var tok = getToken();
        if (tok) {
            h['Authorization'] = 'Bearer ' + tok;
        }
        if (extraHeaders) {
            for (var k in extraHeaders) {
                h[k] = extraHeaders[k];
            }
        }
        return h;
    }

    function buildUrl(endpoint, params) {
        var url = getDomain() + endpoint;
        if (params) {
            var q = [];
            for (var k in params) {
                if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
                    q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
                }
            }
            if (q.length) {
                url += (url.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
            }
        }
        return url;
    }

    function request(method, endpoint, params, body, success, error, noRefresh) {
        var url = buildUrl(endpoint, params);
        var headers = getHeaders();
        if (body && typeof body === 'object') {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(body);
        }

        var authRetried = !!noRefresh;

        function onReqSuccess(data) {
            if (success) success(data);
        }

        function onReqError(err, xhr) {
            // A 24h access token can expire while Lampa is running (TVs often
            // stay on for days). Refresh once through the relay and replay the
            // same request with the new token.
            if (!authRetried && xhr && xhr.status === 401 &&
                typeof ShikiQrAuth !== 'undefined' && ShikiQrAuth.refresh) {
                authRetried = true;
                ShikiQrAuth.refresh(function (ok) {
                    if (ok) {
                        request(method, endpoint, params, body, success, error, true);
                    } else if (error) {
                        error('Сессия истекла, войдите заново');
                    }
                });
                return;
            }
            if (xhr && xhr.status === 401 && error) {
                error('Сессия истекла, войдите заново');
                return;
            }
            if (error) error(err);
        }

        // Use Lampa native request only on Android/SmartTV
        if (window.Lampa && Lampa.Platform && Lampa.Platform.is('android') && Lampa.Reguest) {
            var network = new Lampa.Reguest();
            network.timeout(12000);
            network.native(url, function (res) {
                var json = res;
                if (typeof res === 'string') {
                    try {
                        json = JSON.parse(res);
                    } catch (e) {
                        json = res;
                    }
                }
                onReqSuccess(json);
            }, function (xhr, err) {
                fallbackAjax(method, url, headers, body, onReqSuccess, onReqError);
            }, body, {
                headers: headers,
                dataType: 'json',
                type: method
            });
        } else {
            fallbackAjax(method, url, headers, body, onReqSuccess, onReqError);
        }
    }

    function fallbackAjax(method, url, headers, body, success, error) {
        $.ajax({
            url: url,
            type: method,
            headers: headers,
            data: body,
            dataType: 'json',
            timeout: 12000,
            success: function (data) {
                if (success) success(data);
            },
            error: function (xhr, status, err) {
                if (error) error(err || status || 'Network error', xhr);
            }
        });
    }

    function fixImageUrl(path) {
        if (!path) return '';
        if (path.indexOf('http://') === 0 || path.indexOf('https://') === 0) {
            return path;
        }
        return getDomain() + (path.indexOf('/') === 0 ? path : '/' + path);
    }

    return {
        getDomain: getDomain,
        getToken: getToken,
        getUser: getUser,
        fixImageUrl: fixImageUrl,

        isAuthorized: function () {
            var u = getUser();
            return !!(u && u.id);
        },

        // Login by nickname / public profile
        loginByNickname: function (nickname, success, error) {
            request('GET', '/api/users/' + encodeURIComponent(nickname), null, null, function (data) {
                if (data && data.id) {
                    Lampa.Storage.set('shikimori_user', data);
                    if (success) success(data);
                } else {
                    if (error) error('Пользователь не найден');
                }
            }, error);
        },

        // Verify current token and load user profile
        whoami: function (success, error) {
            request('GET', '/api/users/whoami', null, null, function (data) {
                if (data && data.id) {
                    Lampa.Storage.set('shikimori_user', data);
                    if (success) success(data);
                } else {
                    if (error) error('Invalid user response');
                }
            }, error);
        },

        // User lists: watching, planned, completed, rewatching, on_hold, dropped
        getUserRates: function (status, page, limit, success, error) {
            var u = getUser();
            if (!u || !u.id) {
                if (error) error('Необходима авторизация');
                return;
            }
            var params = {
                page: page || 1,
                limit: limit || 50
            };
            if (status) params.status = status;
            request('GET', '/api/users/' + u.id + '/anime_rates', params, null, success, error);
        },

        // Fast local lookup for user's watched/planned status for any anime
        getUserRate: function (animeId) {
            if (!animeId) return null;
            var map = Lampa.Storage.get('shikimori_rates_map', {}) || {};
            return map[animeId] || null;
        },

        setUserRate: function (animeId, rate) {
            if (!animeId) return;
            var map = Lampa.Storage.get('shikimori_rates_map', {}) || {};
            map[animeId] = rate;
            Lampa.Storage.set('shikimori_rates_map', map);
        },

        // Fetch and cache all user rates in one request for instant badge display
        loadAllUserRates: function (success, error) {
            var u = getUser();
            if (!u || !u.id) {
                if (error) error('Необходима авторизация');
                return;
            }
            request('GET', '/api/users/' + u.id + '/anime_rates', {
                limit: 5000
            }, null, function (data) {
                if (Array.isArray(data)) {
                    var map = {};
                    data.forEach(function (r) {
                        if (r && r.anime && r.anime.id) {
                            map[r.anime.id] = {
                                id: r.id,
                                status: r.status,
                                episodes: r.episodes,
                                score: r.score
                            };
                        }
                    });
                    Lampa.Storage.set('shikimori_rates_map', map);
                    Lampa.Storage.set('shikimori_rates_at', Date.now());
                    if (success) success(map);
                } else {
                    if (error) error('Invalid response');
                }
            }, error);
        },

        // User watch history
        getUserHistory: function (page, limit, success, error) {
            var u = getUser();
            if (!u || !u.id) {
                if (error) error('Необходима авторизация');
                return;
            }
            request('GET', '/api/users/' + u.id + '/history', {
                page: page || 1,
                limit: limit || 30,
                target_type: 'Anime'
            }, null, success, error);
        },

        // Local watch history & watched episodes
        getLocalWatchedEpisodes: function (animeId) {
            if (!animeId) return [];
            var map = Lampa.Storage.get('shikimori_local_watched_eps', {}) || {};
            if (typeof map !== 'object' || map === null) map = {};
            var res = map[String(animeId)] || [];
            return Array.isArray(res) ? res : [];
        },

        markLocalEpisodeWatched: function (anime, episodeNum) {
            if (!anime || !anime.id || !episodeNum) return;
            var aId = String(anime.id);
            var map = Lampa.Storage.get('shikimori_local_watched_eps', {}) || {};
            if (typeof map !== 'object' || map === null) map = {};
            var list = map[aId] || [];
            if (!Array.isArray(list)) list = [];
            var epInt = parseInt(episodeNum, 10);
            if (list.indexOf(epInt) === -1) {
                list.push(epInt);
                list.sort(function (a, b) { return a - b; });
                map[aId] = list;
                Lampa.Storage.set('shikimori_local_watched_eps', map);
            }

            var history = Lampa.Storage.get('shikimori_local_history', []) || [];
            if (!Array.isArray(history)) history = [];
            history = history.filter(function (h) { return String(h.id) !== aId; });
            var totalEps = anime.episodes || anime.episodes_total || 0;
            history.unshift({
                id: anime.id,
                title: anime.russian || anime.name || anime.title,
                name: anime.name || anime.title,
                russian: anime.russian || anime.title,
                image: anime.image || (anime.poster_path ? { preview: anime.poster_path, original: anime.poster_path } : null),
                poster_path: anime.poster_path || (anime.image ? (anime.image.original || anime.image.preview) : ''),
                vote_average: anime.score || anime.vote_average,
                episodes_total: totalEps,
                lastEpisode: epInt,
                episodes_watched: list.length,
                timestamp: Date.now()
            });
            if (history.length > 40) history = history.slice(0, 40);
            Lampa.Storage.set('shikimori_local_history', history);

            // Keep the local episode map bounded to the same anime as history;
            // otherwise it grows forever on a long-lived TV installation.
            var allowed = {};
            history.forEach(function (h) { allowed[String(h.id)] = true; });
            var pruned = false;
            Object.keys(map).forEach(function (key) {
                if (!allowed[key]) {
                    delete map[key];
                    pruned = true;
                }
            });
            if (pruned) Lampa.Storage.set('shikimori_local_watched_eps', map);

            if (window.shikiSendLog) {
                window.shikiSendLog('MARK_LOCAL_WATCHED: aId=' + aId + ' ep=' + epInt + ' listLen=' + list.length + ' histLen=' + history.length);
            }
        },

        getLocalHistory: function () {
            return Lampa.Storage.get('shikimori_local_history', []) || [];
        },

        clearLocalHistory: function () {
            Lampa.Storage.set('shikimori_local_history', []);
            Lampa.Storage.set('shikimori_local_watched_eps', {});
        },

        // Search anime catalog on Shikimori
        searchAnime: function (query, limit, success, error) {
            request('GET', '/api/animes', {
                search: query,
                limit: limit || 20,
                order: 'popularity'
            }, null, success, error);
        },

        // Get anime catalog with advanced filters (order, genre, season, score, status, kind)
        getCatalog: function (filters, page, limit, success, error) {
            var params = {
                page: page || 1,
                limit: limit || 30
            };
            if (filters) {
                if (filters.order && filters.order !== 'all') params.order = filters.order;
                if (filters.genre && filters.genre !== 'all') params.genre = filters.genre;
                if (filters.season && filters.season !== 'all') params.season = filters.season;
                if (filters.score && filters.score !== 'all') params.score = filters.score;
                if (filters.status && filters.status !== 'all') params.status = filters.status;
                if (filters.kind && filters.kind !== 'all') params.kind = filters.kind;
                if (filters.search) params.search = filters.search;
            }
            request('GET', '/api/animes', params, null, success, error);
        },

        // Get full anime info by ID
        getAnime: function (id, success, error) {
            request('GET', '/api/animes/' + id, null, null, success, error);
        },

        // Get embedded watch page data directly from /animes/:id/watch
        getWatchPageData: function (id, success, error) {
            var url = getDomain() + '/animes/' + id + '/watch';
            $.ajax({
                url: url,
                type: 'GET',
                dataType: 'html',
                timeout: 10000,
                success: function (html) {
                    try {
                        var match = html.match(/<script id="translations"[^>]*>([\s\S]*?)<\/script>/);
                        if (match && match[1]) {
                            var transJson = JSON.parse(match[1]);
                            if (success) success(transJson);
                            return;
                        }
                    } catch (e) {}
                    if (error) error('No translations on /watch');
                },
                error: function (xhr, status, err) {
                    if (error) error(err || status);
                }
            });
        },

        // Update watched episodes in user_rate
        updateProgress: function (animeId, rateId, episodeNumber, totalEpisodes, success, error) {
            var u = getUser();
            if (!u || !u.id) {
                if (error) error('Не авторизован');
                return;
            }

            var map = Lampa.Storage.get('shikimori_rates_map', {}) || {};
            if (!rateId && map[animeId] && map[animeId].id) {
                rateId = map[animeId].id;
            }

            var newStatus = 'watching';
            if (totalEpisodes && episodeNumber >= totalEpisodes) {
                newStatus = 'completed';
            }

            var payload = {
                user_rate: {
                    episodes: episodeNumber,
                    status: newStatus
                }
            };

            function onUpdateSuccess(res) {
                var currentMap = Lampa.Storage.get('shikimori_rates_map', {}) || {};
                var savedId = (res && res.id) || rateId;
                currentMap[animeId] = {
                    id: savedId,
                    status: newStatus,
                    episodes: episodeNumber
                };
                Lampa.Storage.set('shikimori_rates_map', currentMap);
                if (window.Lampa && Lampa.Listener) {
                    Lampa.Listener.send('shikimori_progress_updated', {
                        animeId: animeId,
                        episode: episodeNumber,
                        rateId: savedId,
                        status: newStatus
                    });
                }
                if (success) success(res);
            }

            if (rateId) {
                request('PATCH', '/api/v2/user_rates/' + rateId, null, payload, onUpdateSuccess, error);
            } else {
                payload.user_rate.user_id = u.id;
                payload.user_rate.target_id = animeId;
                payload.user_rate.target_type = 'Anime';
                request('POST', '/api/v2/user_rates', null, payload, onUpdateSuccess, error);
            }
        },

        // OAuth is handled by the relay server (see qrauth.js): the client
        // secret must never ship inside the plugin, every user gets their own
        // token through the QR flow.

        logout: function () {
            Lampa.Storage.set('shikimori_token', '');
            Lampa.Storage.set('shikimori_refresh_token', '');
            Lampa.Storage.set('shikimori_user', null);
            Lampa.Storage.set('shikimori_rates_map', {});
        }
    };
})();
window.ShikiApi = ShikiApi;
