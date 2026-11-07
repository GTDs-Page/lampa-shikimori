/**
 * Shikimori Plugin for Lampa
 * Version: 2.3.0
 * Author: GTD
 * Features:
 *   - Direct anime playback with Russian voiceovers (AniLibria, Studio Band, AniDUB, etc.)
 *   - Full integration with Shikimori account (Watching, Planned, History, Completed)
 *   - Auto-sync watched episodes and progress back to Shikimori
 *   - Seamless search integration in Lampa cards
 *   - Optimized for Android TV remote controls
 */
(function () {
    'use strict';


/* --- api.js --- */
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


/* --- kodik.js --- */
/**
 * Kodik Balancer for Lampa Shikimori Plugin
 */
var KodikBalancer = (function () {
    var DEFAULT_TOKENS = [
        '56a768d08f43091901c44b54fe970049',
        '41dd95f84c21719b09d6c71182237a25',
        '77b567ec164db6ca9162d2f3dc4948c3'
    ];
    var API_DOMAIN = 'https://kodik-api.com';

    function getToken() {
        var userTok = Lampa.Storage.get('kodik_token', '');
        return userTok || DEFAULT_TOKENS[0];
    }

    function searchByShikimoriId(shikimoriId, success, error) {
        if (!shikimoriId) {
            if (error) error('Kodik: пустой shikimori_id');
            return;
        }
        var tokenIndex = 0;

        function tryNextToken() {
            if (tokenIndex >= DEFAULT_TOKENS.length) {
                if (error) error('Kodik: ничего не найдено по shikimori_id ' + shikimoriId);
                return;
            }
            var token = Lampa.Storage.get('kodik_token', '') || DEFAULT_TOKENS[tokenIndex];
            var url = API_DOMAIN + '/search?token=' + token + '&shikimori_id=' + encodeURIComponent(shikimoriId) + '&with_episodes=true&with_material_data=true';

            requestJson(url, function (data) {
                if (data && data.results && data.results.length) {
                    if (success) success(formatKodikResults(data.results));
                } else if (!Lampa.Storage.get('kodik_token', '') && tokenIndex + 1 < DEFAULT_TOKENS.length) {
                    tokenIndex++;
                    tryNextToken();
                } else {
                    if (error) error('Kodik: ничего не найдено по shikimori_id ' + shikimoriId);
                }
            }, function () {
                tokenIndex++;
                if (tokenIndex < DEFAULT_TOKENS.length) {
                    tryNextToken();
                } else {
                    if (error) error('Kodik: ошибка запроса по shikimori_id ' + shikimoriId);
                }
            });
        }

        tryNextToken();
    }

    function searchByTitle(title, success, error) {
        if (!title) {
            if (error) error('Kodik: пустое название для поиска');
            return;
        }
        var token = getToken();
        var url = API_DOMAIN + '/search?token=' + token + '&title=' + encodeURIComponent(title) + '&with_episodes=true&with_material_data=true';

        requestJson(url, function (data) {
            if (data && data.results && data.results.length) {
                if (success) success(formatKodikResults(data.results));
            } else {
                if (error) error('Kodik: ничего не найдено по названию ' + title);
            }
        }, error);
    }

    function formatKodikResults(results) {
        var translations = [];
        var translationsMap = {};

        results.forEach(function (res) {
            var transTitle = res.translation ? res.translation.title : 'Оригинал';
            var transId = res.translation ? res.translation.id : 0;
            var transType = res.translation ? (res.translation.type === 'subtitles' ? 'Субтитры' : 'Озвучка') : '';

            var transObj = translationsMap[transId];
            if (!transObj) {
                transObj = {
                    id: transId,
                    title: transTitle,
                    type: transType,
                    quality: res.quality || '1080p',
                    seasons: {}
                };
                translationsMap[transId] = transObj;
                translations.push(transObj);
            }

            // Extract episodes
            if (res.seasons) {
                for (var sNum in res.seasons) {
                    var sData = res.seasons[sNum];
                    if (!transObj.seasons[sNum]) {
                        transObj.seasons[sNum] = {
                            season: parseInt(sNum),
                            episodes: []
                        };
                    }
                    if (sData.episodes) {
                        for (var epNum in sData.episodes) {
                            var link = sData.episodes[epNum];
                            if (link.indexOf('//') === 0) link = 'https:' + link;
                            transObj.seasons[sNum].episodes.push({
                                episode: parseInt(epNum),
                                link: link
                            });
                        }
                        // Sort episodes ascending
                        transObj.seasons[sNum].episodes.sort(function (a, b) {
                            return a.episode - b.episode;
                        });
                    }
                }
            } else if (res.link) {
                // Single movie/OVA
                var mLink = res.link.indexOf('//') === 0 ? 'https:' + res.link : res.link;
                transObj.seasons['1'] = {
                    season: 1,
                    episodes: [{
                        episode: 1,
                        link: mLink
                    }]
                };
            }
        });

        return translations;
    }

    /**
     * Decode Kodik ROT18 + Base64 stream URL
     */
    function decodeKodikSrc(src) {
        if (!src || src.indexOf('//') !== -1) return src;
        var rotated = src.replace(/[a-zA-Z]/g, function (e) {
            return String.fromCharCode((e <= 'Z' ? 90 : 122) >= (e = e.charCodeAt(0) + 18) ? e : e - 26);
        });
        try {
            var decoded = atob(rotated);
            if (decoded.indexOf('//') === 0) decoded = 'https:' + decoded;
            return decoded;
        } catch (e) {
            return src;
        }
    }

    /**
     * Resolves direct stream (.m3u8) from a Kodik iframe link
     */
    function resolveStream(embedUrl, success, error) {
        if (!embedUrl) {
            if (error) error('Empty URL');
            return;
        }
        var cleanUrl = embedUrl.indexOf('//') === 0 ? 'https:' + embedUrl : embedUrl;

        // Fetch iframe HTML to extract player video params
        requestHtml(cleanUrl, function (html) {
            try {
                var domainMatch = html.match(/var\s+domain\s*=\s*["']([^"']+)["']/);
                var dSignMatch = html.match(/var\s+d_sign\s*=\s*["']([^"']+)["']/);
                var pdMatch = html.match(/var\s+pd\s*=\s*["']([^"']+)["']/);
                var pdSignMatch = html.match(/var\s+pd_sign\s*=\s*["']([^"']+)["']/);
                var refMatch = html.match(/var\s+ref\s*=\s*["']([^"']+)["']/);
                var refSignMatch = html.match(/var\s+ref_sign\s*=\s*["']([^"']+)["']/);
                var typeMatch = html.match(/var\s+type\s*=\s*["']([^"']+)["']/);
                var videoIdMatch = html.match(/var\s+videoId\s*=\s*["']([^"']+)["']/);

                // Try regex extraction first
                var matchPath = cleanUrl.match(/\/(seria|video|serial|episode)\/(\d+)\/([a-zA-Z0-9]+)/);
                var type = typeMatch ? typeMatch[1] : (matchPath ? matchPath[1] : 'seria');
                var id = videoIdMatch ? videoIdMatch[1] : (matchPath ? matchPath[2] : '');
                var hash = matchPath ? matchPath[3] : '';

                if (!id || !hash) {
                    var parts = cleanUrl.split('/');
                    for (var i = 0; i < parts.length; i++) {
                        if (parts[i] === 'seria' || parts[i] === 'video' || parts[i] === 'serial' || parts[i] === 'episode') {
                            if (!type) type = parts[i];
                            if (!id) id = parts[i + 1] || '';
                            if (!hash) hash = parts[i + 2] || '';
                            break;
                        }
                    }
                }

                var domain = domainMatch ? domainMatch[1] : (cleanUrl.match(/https?:\/\/([^\/]+)/) ? cleanUrl.match(/https?:\/\/([^\/]+)/)[1] : 'kodikplayer.com');

                if (hash && id) {
                    var ftorUrl = 'https://' + domain + '/ftor';
                    var postObj = {
                        d: domain,
                        d_sign: dSignMatch ? dSignMatch[1] : '',
                        pd: pdMatch ? pdMatch[1] : domain,
                        pd_sign: pdSignMatch ? pdSignMatch[1] : '',
                        ref: refMatch ? refMatch[1] : '',
                        ref_sign: refSignMatch ? refSignMatch[1] : '',
                        bad_user: 'false',
                        cdn_is_working: 'true',
                        type: type,
                        hash: hash,
                        id: id
                    };

                    var postData = Object.keys(postObj).map(function (k) {
                        return encodeURIComponent(k) + '=' + encodeURIComponent(postObj[k]);
                    }).join('&');

                    var reqHeaders = {
                        'Referer': cleanUrl,
                        'Origin': 'https://' + domain,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    };

                    requestPost(ftorUrl, postData, reqHeaders, function (res) {
                        if (res && res.links) {
                            var bestQuality = res.links['720'] || res.links['1080'] || res.links['480'] || res.links['360'] || res.links['240'];
                            if (bestQuality && bestQuality.length) {
                                var src = decodeKodikSrc(bestQuality[0].src);
                                success({
                                    streamUrl: src,
                                    quality: '720p',
                                    isHls: true
                                });
                                return;
                            }
                        }
                        if (error) error('Kodik: поток не найден в ответе');
                    }, function (err) {
                        if (error) error('Kodik /ftor error: ' + err);
                    });
                    return;
                }
            } catch (e) {
                console.warn('Kodik stream parsing error:', e);
            }
            if (error) error('Kodik: не удалось извлечь параметры видео');
        }, function () {
            if (error) error('Kodik: ошибка загрузки страницы плеера');
        });
    }

    function requestPost(url, data, headers, success, error) {
        if (typeof headers === 'function') {
            error = success;
            success = headers;
            headers = {};
        }
        headers = headers || {};

        if (window.Lampa && Lampa.Reguest) {
            var network = new Lampa.Reguest();
            network.timeout(10000);
            network.native(url, function (res) {
                var json = res;
                if (typeof res === 'string') {
                    try {
                        json = JSON.parse(res);
                    } catch (e) {
                        if (error) error('JSON parse error: ' + e.message);
                        return;
                    }
                }
                if (success) success(json);
            }, function (xhr, err) {
                fallbackAjaxPost(url, data, headers, success, error);
            }, data, { headers: headers, dataType: 'json' });
        } else {
            fallbackAjaxPost(url, data, headers, success, error);
        }
    }

    function fallbackAjaxPost(url, data, headers, success, error) {
        $.ajax({
            url: url,
            type: 'POST',
            data: data,
            headers: headers || {},
            dataType: 'json',
            timeout: 10000,
            success: success,
            error: function (xhr, s, err) {
                if (error) error(err || s || 'Network error');
            }
        });
    }

    function requestJson(url, success, error) {
        if (window.Lampa && Lampa.Reguest) {
            var network = new Lampa.Reguest();
            network.timeout(10000);
            network.native(url, function (res) {
                var json = res;
                if (typeof res === 'string') {
                    try {
                        json = JSON.parse(res);
                    } catch (e) {
                        if (error) error('Kodik JSON parse error');
                        return;
                    }
                }
                if (success) success(json);
            }, error);
        } else {
            $.ajax({
                url: url,
                dataType: 'json',
                timeout: 10000,
                success: success,
                error: function (xhr, s, err) { if (error) error(err || s); }
            });
        }
    }

    function requestHtml(url, success, error) {
        if (window.Lampa && Lampa.Reguest) {
            var network = new Lampa.Reguest();
            network.timeout(10000);
            network.native(url, function (res) {
                if (success) success(res);
            }, error, false, { dataType: 'text' });
        } else {
            $.ajax({
                url: url,
                dataType: 'text',
                timeout: 10000,
                success: success,
                error: function (xhr, s, err) { if (error) error(err || s); }
            });
        }
    }

    return {
        searchByShikimoriId: searchByShikimoriId,
        searchByTitle: searchByTitle,
        resolveStream: resolveStream
    };
})();


/* --- anilibria.js --- */
/**
 * AniLibria Balancer for Lampa Shikimori Plugin
 */
var AniLibriaBalancer = (function () {
    var API_URL = 'https://api.anilibria.top/v3';

    function search(query, success, error) {
        if (!query) {
            if (error) error('Query is empty');
            return;
        }

        var url = API_URL + '/title/search?search=' + encodeURIComponent(query);
        
        requestJson(url, function (data) {
            var list = data && data.list ? data.list : (Array.isArray(data) ? data : []);
            if (list.length) {
                success(formatAniLibriaReleases(list));
            } else {
                if (error) error('AniLibria: релизы не найдены');
            }
        }, error);
    }

    function formatAniLibriaReleases(list) {
        var results = [];
        list.forEach(function (rel) {
            var title = (rel.names && rel.names.ru) ? rel.names.ru : (rel.names ? rel.names.en : rel.code);
            var host = rel.player && rel.player.host ? ('https://' + rel.player.host) : 'https://cache.libria.fun';
            
            var episodes = [];
            if (rel.player && rel.player.list) {
                for (var epNum in rel.player.list) {
                    var ep = rel.player.list[epNum];
                    var hls = ep.hls || {};
                    var streamPath = hls.fhd || hls.hd || hls.sd || '';
                    if (streamPath) {
                        episodes.push({
                            episode: parseInt(epNum),
                            title: 'Серия ' + epNum,
                            streamUrl: host + streamPath,
                            quality: hls.fhd ? '1080p' : (hls.hd ? '720p' : '480p')
                        });
                    }
                }
                episodes.sort(function (a, b) { return a.episode - b.episode; });
            }

            if (episodes.length) {
                results.push({
                    id: rel.id || rel.code,
                    title: 'AniLibria (Официальная озвучка)',
                    type: 'Озвучка',
                    quality: '1080p FHD',
                    seasons: {
                        '1': {
                            season: 1,
                            episodes: episodes
                        }
                    }
                });
            }
        });
        return results;
    }

    function requestJson(url, success, error) {
        if (window.Lampa && Lampa.Reguest) {
            var network = new Lampa.Reguest();
            network.timeout(3500);
            network.native(url, function (res) {
                var json = res;
                if (typeof res === 'string') {
                    try {
                        json = JSON.parse(res);
                    } catch (e) {
                        if (error) error('AniLibria JSON parse error');
                        return;
                    }
                }
                if (success) success(json);
            }, error);
        } else {
            $.ajax({
                url: url,
                dataType: 'json',
                timeout: 3500,
                success: success,
                error: function (xhr, s, err) { if (error) error(err || s); }
            });
        }
    }

    return {
        search: search
    };
})();


/* --- player.js --- */
/**
 * Player integration and Shikimori progress synchronization
 */
var ShikiPlayer = (function () {
    var currentPlaying = null;
    var markedEpisodes = {}; // Keep track of already synced episodes in session

    function init() {
        if (!window.Lampa) return;

        // Listen for internal player time updates
        if (window.Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('timeupdate', onTimeUpdate);
            Lampa.PlayerVideo.listener.follow('destroy', onDestroy);
        }
        if (window.Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('destroy', onDestroy);
        }
        if (window.Lampa.Listener) {
            Lampa.Listener.follow('player', function (e) {
                if (window.shikiSendLog) window.shikiSendLog('PLAYER_BUS_EVENT: ' + (e && e.type));
                if (e && e.type === 'destroy') {
                    onDestroy();
                }
            });
        }
    }

    function play(params) {
        /**
         * params:
         *   anime: { id, name, russian, episodes, rateId }
         *   season: number
         *   episode: number
         *   streamUrl: string
         *   quality: string
         *   voiceTitle: string
         *   playlist: array of episodes (for auto-next)
         */
        currentPlaying = params;
        var anime = (params && params.anime) || {};
        var animeTitle = anime.russian || anime.name || params.title || 'Аниме';
        var seasonNum = params.season || 1;
        var episodeNum = params.episode || 1;
        var streamUrl = params.streamUrl || params.url || '';
        var voiceSub = params.voiceTitle || params.subtitle || '';
        var fullTitle = animeTitle + (voiceSub ? ' — ' + voiceSub : '') + ' (С' + seasonNum + ' E' + episodeNum + ')';

        if (window.shikiSendLog) {
            window.shikiSendLog('PLAYER_PLAY: ep=' + episodeNum + ' anime=' + animeTitle + ' id=' + anime.id);
        }

        var playlistItem = {
            title: fullTitle,
            url: streamUrl,
            timeline: {
                hash: 'shiki_' + (anime.id || '0') + '_s' + seasonNum + '_e' + episodeNum
            }
        };

        var playlist = [];
        if (params.playlist && params.playlist.length) {
            playlist = params.playlist.map(function (item) {
                return {
                    title: animeTitle + ' — Серия ' + item.episode,
                    url: item.streamUrl || item.link,
                    timeline: {
                        hash: 'shiki_' + (anime.id || '0') + '_s' + seasonNum + '_e' + item.episode
                    }
                };
            });
        } else {
            playlist.push(playlistItem);
        }

        // Set player callback for next/finish
        if (window.Lampa && Lampa.Player && Lampa.Player.callback) {
            Lampa.Player.callback(function () {
                checkAndMarkProgress(true);
                if (window.Lampa && Lampa.Controller) {
                    Lampa.Controller.toggle('content');
                }
            });
        }

        // Launch playback in Lampa Player (which routes to Vimu or internal player based on user settings)
        Lampa.Player.play(playlistItem);
        Lampa.Player.playlist(playlist);
    }

    function onTimeUpdate(data) {
        if (!currentPlaying || !data || !data.duration || data.duration <= 0) return;

        var threshold = parseFloat(Lampa.Storage.get('shikimori_sync_percent', '80')) / 100;
        if (isNaN(threshold) || threshold <= 0) threshold = 0.8;
        var current = data.current || 0;
        var duration = data.duration || 1;
        var ratio = current / duration;

        // Mark when ratio >= threshold or remaining time is less than 90 seconds
        if (ratio >= threshold || (duration - current) <= 90) {
            checkAndMarkProgress(false);
        }
    }

    function onDestroy() {
        if (window.shikiSendLog) window.shikiSendLog('PLAYER_ON_DESTROY');
        checkAndMarkProgress(true);
        currentPlaying = null;
        if (window.Lampa && Lampa.Controller) {
            Lampa.Controller.toggle('content');
        }
    }

    function checkAndMarkProgress(isEnd) {
        if (!currentPlaying || !currentPlaying.anime) {
            if (window.shikiSendLog) window.shikiSendLog('CHECK_PROGRESS: no currentPlaying');
            return;
        }

        var anime = currentPlaying.anime;
        if (!anime.id) {
            if (window.shikiSendLog) window.shikiSendLog('CHECK_PROGRESS: no anime.id');
            return;
        }
        var epNum = currentPlaying.episode;
        if (window.shikiSendLog) window.shikiSendLog('CHECK_PROGRESS: anime=' + anime.id + ' ep=' + epNum + ' isEnd=' + isEnd);

        // This runs on every timeupdate once the threshold is crossed. Without an
        // early guard it wrote localStorage and sent an event several times per
        // second during playback, which is what made the player stutter on a TV.
        var syncKey = anime.id + '_' + epNum;
        if (markedEpisodes[syncKey]) return;
        markedEpisodes[syncKey] = true;

        // Save locally so watched status is visible immediately (also for guests)
        if (typeof ShikiApi !== 'undefined' && ShikiApi.markLocalEpisodeWatched) {
            ShikiApi.markLocalEpisodeWatched(anime, epNum);
        }

        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.send('shikimori_progress_updated', {
                animeId: anime.id,
                episode: epNum
            });
        }

        // Check if auto-sync is enabled in settings and user is authorized
        var autoSync = Lampa.Storage.get('shikimori_auto_sync', true);
        if (!autoSync || !ShikiApi.isAuthorized()) return;

        // Send progress to Shikimori API
        ShikiApi.updateProgress(anime.id, anime.rateId, epNum, anime.episodes, function (res) {
            if (res && res.id) {
                anime.rateId = res.id;
            }
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show('Shikimori: Серия ' + epNum + ' отмечена в профиле!', { time: 4000 });
            }
        }, function (err) {
            console.warn('Shikimori progress sync error:', err);
        });
    }

    return {
        init: init,
        play: play,
        checkAndMarkProgress: checkAndMarkProgress
    };
})();
window.ShikiPlayer = ShikiPlayer;


/* --- keyboard.js --- */
/**
 * Text input for the Shikimori plugin.
 *
 * The plugin used to draw its own keyboard overlay. On a TV that meant a second
 * focus system fighting with Lampa's one: the hidden <input> opened the Android
 * IME on top of the overlay, Back could call both onDone and onCancel, and after
 * closing the overlay the controller was left on a destroyed "shiki_keyboard".
 *
 * Lampa already ships a D-pad friendly on-screen keyboard (the same one used by
 * search and settings, with layouts, shift, backspace and Back handling), so the
 * plugin now just delegates to it.
 */
var ShikiKeyboard = (function () {
    'use strict';

    function platformIsTv() {
        try {
            return !!(window.Lampa && Lampa.Platform && Lampa.Platform.screen && Lampa.Platform.screen('tv'));
        } catch (e) {
            return false;
        }
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

    /**
     * Lampa's Input closes itself by toggling the settings controller. When the
     * keyboard was opened from a plugin page (and not from Settings) that
     * controller does not exist, so the D-pad would stay bound to the destroyed
     * keyboard. Put the previous controller back if Lampa did not do it.
     */
    function restoreController(previous) {
        try {
            if (!window.Lampa || !Lampa.Controller || !previous) return;
            var current = enabledControllerName();
            if (current === 'keybord' || current === 'select') {
                Lampa.Controller.toggle(previous);
            }
        } catch (e) {}
    }

    function open(params) {
        params = params || {};

        var onDone = typeof params.onDone === 'function' ? params.onDone : null;
        var onCancel = typeof params.onCancel === 'function' ? params.onCancel : null;
        var previous = enabledControllerName();
        var finished = false;

        function finish(value) {
            if (finished) return;
            finished = true;
            restoreController(previous);

            var text = value === null || value === undefined ? '' : String(value).trim();
            if (text) {
                if (onDone) onDone(text);
            } else if (onCancel) {
                onCancel();
            }
        }

        if (window.Lampa && Lampa.Input && typeof Lampa.Input.edit === 'function') {
            var editParams = {
                title: params.title || 'Поиск аниме на Shikimori',
                value: params.value || '',
                free: true,
                nosave: true,
                nomic: true
            };

            // On a TV always use Lampa's own on-screen keyboard: it is the only
            // one the D-pad can drive without opening the system IME.
            if (platformIsTv()) editParams.keyboard = 'lampa';

            try {
                Lampa.Input.edit(editParams, finish);
                return;
            } catch (e) {
                // fall through to the plain prompt below
            }
        }

        var value = window.prompt ? window.prompt(params.title || 'Поиск', params.value || '') : null;
        if (value !== null) finish(value);
        else if (onCancel) onCancel();
    }

    return {
        open: open,
        // Nothing to tear down: Lampa owns the keyboard overlay.
        close: function () {}
    };
})();


/* --- qrauth.js --- */
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


/* --- settings.js --- */
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


/* --- ui.js --- */
/**
 * Lampa UI Components for Shikimori Plugin
 * Fully adapted for Android TV D-Pad Remote Navigation
 */
var ShikiUI = (function () {
    var SHIKI_ICON = '<svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>';
    var DISCOVERY_TTL = 10 * 60 * 1000;
    var discoveryCache = { at: 0, rows: null };

    function getNavigator() {
        if (typeof Navigator !== 'undefined' && Navigator && typeof Navigator.move === 'function') return Navigator;
        if (typeof window !== 'undefined' && window.Navigator && typeof window.Navigator.move === 'function') return window.Navigator;
        if (typeof Lampa !== 'undefined' && Lampa.Navigator && typeof Lampa.Navigator.move === 'function') return Lampa.Navigator;
        return null;
    }

    function navFocus(target, htmlContainer) {
        if (!target) return;
        var elem = target instanceof jQuery ? target[0] : target;
        if (!elem || !document.contains(elem)) return;

        // One call only. Navigator.focus already emits "focus", which makes
        // Lampa's Controller set select_active, move the focus class and fire
        // hover:focus. Doing that by hand as well fired hover:focus three times
        // per move, which is what made scrolling and card animations stutter.
        if (window.Lampa && Lampa.Controller && Lampa.Controller.collectionFocus && htmlContainer) {
            var html = htmlContainer instanceof jQuery ? htmlContainer[0] : htmlContainer;
            Lampa.Controller.collectionFocus(elem, html, true);
        } else if (window.Lampa && Lampa.Controller && Lampa.Controller.focus) {
            Lampa.Controller.focus(elem);
        }
    }

    /**
     * Is this component the activity currently on screen? Async callbacks (page
     * loads, progress events) used to re-collect and re-focus the global
     * Navigator collection even when their page was buried under another one,
     * which left the remote controlling invisible content.
     */
    function isActive(component) {
        try {
            if (!component || !window.Lampa || !Lampa.Activity || !Lampa.Activity.own) return true;
            return !!Lampa.Activity.own(component);
        } catch (e) {
            return false;
        }
    }

    /**
     * May this page touch the global focus collection right now? While a modal,
     * selectbox, keyboard, player or the head/menu layer is active the "content"
     * controller is not ours; re-collecting there would steal the focus from the
     * layer the user is actually using.
     */
    function navigationAllowed(component) {
        if (!isActive(component)) return false;
        var name = enabledControllerName();
        return !name || name === 'content';
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

    /**
     * Keep the focused card visible inside a horizontal row. The Navigator moves
     * focus spatially and knows nothing about nested scrollers, so without this
     * the focus disappears off the right edge of Lampa-like rows.
     */
    function scrollRow(element) {
        if (!element || !element.closest) return;
        var row = element.closest('.shiki-hub-cards, .shiki-filter-pills, .shikimori-view__voices, .shikimori-view__seasons');
        if (!row || row.scrollWidth <= row.clientWidth + 4) return;

        var itemRect = element.getBoundingClientRect();
        var rowRect = row.getBoundingClientRect();
        var offset = (itemRect.left - rowRect.left) - (rowRect.width - itemRect.width) / 2;
        if (Math.abs(offset) < 8) return;

        var target = row.scrollLeft + offset;
        target = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, target));
        $(row).stop(true).animate({ scrollLeft: target }, 140);
    }

    function init() {
        injectStyles();
        registerMenu();
        registerFullCardButton();
        registerComponents();
    }

    function injectStyles() {
        var css = `
            /* Strict constraints for SVGs on TV */
            .shiki-icon,
            .shiki-catalog-header svg,
            .shiki-search-wrapper svg,
            .shiki-card svg,
            .btn-shiki-search-shortcut svg,
            .shiki-filter-row svg,
            .shiki-hub-search-btn svg,
            .shiki-hub-catalog-btn svg {
                width: 20px !important;
                height: 20px !important;
                min-width: 20px !important;
                min-height: 20px !important;
                max-width: 20px !important;
                max-height: 20px !important;
                display: inline-block !important;
                vertical-align: middle !important;
                flex-shrink: 0 !important;
            }

            .shiki-badge {
                position: absolute;
                bottom: 0.5em;
                left: 0.5em;
                background: rgba(0, 0, 0, 0.82);
                border-radius: 4px;
                padding: 0.2em 0.5em;
                font-size: 0.78em;
                font-weight: bold;
                color: #2ecc71;
                border: 1px solid rgba(46, 204, 113, 0.4);
                z-index: 2;
                pointer-events: none;
            }

            .shiki-score {
                position: absolute;
                top: 0.5em;
                right: 0.5em;
                background: rgba(241, 196, 15, 0.95);
                border-radius: 4px;
                padding: 0.15em 0.45em;
                font-size: 0.78em;
                font-weight: bold;
                color: #000;
                z-index: 2;
                pointer-events: none;
            }

            /* TV D-Pad Focus Highlights.
               No will-change/backdrop-filter/shadows on every card: on a TV that
               meant a compositing layer and a blur pass per poster (200+ of them
               in the hub), which is exactly what made navigation stutter. */
            .shiki-card {
                box-sizing: border-box !important;
                transition: transform 0.18s ease-out, box-shadow 0.18s ease-out !important;
                outline: none !important;
                border-radius: 1em !important;
                cursor: pointer !important;
                position: relative !important;
                contain: layout style;
            }
            .shiki-card.focus {
                transform: scale(1.05) !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 6px 14px rgba(0, 0, 0, 0.55) !important;
                z-index: 10 !important;
                will-change: transform;
            }
            .shiki-card.focus .card__title {
                color: #2ecc71 !important;
            }

            /* Standard 2:3 vertical poster proportions matching Lampa cards */
            .shiki-card .card__view {
                position: relative !important;
                width: 100% !important;
                padding-bottom: 150% !important;
                height: 0 !important;
                border-radius: 0.9em !important;
                overflow: hidden !important;
                background: #1c2026 !important;
            }
            .shiki-card .card__view img,
            .shiki-card .card__img {
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: 100% !important;
                object-fit: cover !important;
                border-radius: 0.9em !important;
            }

            .shiki-card .card__title {
                margin-top: 0.6em !important;
                font-size: 1.05em !important;
                font-weight: 600 !important;
                line-height: 1.25 !important;
                height: 2.5em !important;
                display: -webkit-box !important;
                -webkit-line-clamp: 2 !important;
                -webkit-box-orient: vertical !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                color: #ffffff !important;
            }

            .shiki-card .card__age,
            .shiki-card .card__subtitle {
                font-size: 0.85em !important;
                color: #9aa0a6 !important;
                margin-top: 0.25em !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
            }

            .shiki-hub-cards {
                display: flex !important;
                gap: 1.2em !important;
                overflow-x: auto !important;
                padding: 0.8em 0.4em 1.4em 0.4em !important;
                scrollbar-width: none !important;
            }
            .shiki-hub-cards::-webkit-scrollbar {
                display: none !important;
            }
            .shiki-hub-cards .card {
                width: 13.5em !important;
                min-width: 13.5em !important;
                max-width: 13.5em !important;
                flex-shrink: 0 !important;
            }

            /* General Catalog Grid of Titles - 7 cards per row on the TV's
               ~960 CSS px viewport, fewer only on genuinely narrow screens. */
            .category-full.shiki-catalog-grid,
            .category-full.shiki-search-grid-box,
            .shiki-catalog-grid,
            .shiki-search-grid-box {
                display: flex !important;
                flex-wrap: wrap !important;
                width: 100% !important;
                box-sizing: border-box !important;
                margin-bottom: 4em !important;
                padding-bottom: 2em !important;
            }

            .shiki-catalog-grid .card,
            .shiki-search-grid-box .card {
                width: 14.2857% !important;
                box-sizing: border-box !important;
                padding: 0 0.5em !important;
                margin-bottom: 2em !important;
                flex-shrink: 0 !important;
                min-width: 0 !important;
                max-width: none !important;
                display: flex !important;
                flex-direction: column !important;
            }

            @media (max-width: 1100px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 14.2857% !important;
                }
            }
            @media (max-width: 900px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 16.6667% !important;
                }
            }
            @media (max-width: 750px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 20% !important;
                }
            }
            @media (max-width: 600px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 25% !important;
                }
            }

            .shiki-pill {
                padding: 0.4em 0.8em;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 6px;
                font-size: 0.85em;
                cursor: pointer;
                transition: all 0.15s ease;
                white-space: nowrap;
                flex-shrink: 0;
                outline: none !important;
            }
            .shiki-pill.focus {
                background: #ffffff !important;
                color: #111111 !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 2px #2ecc71, 0 4px 12px rgba(0,0,0,0.6) !important;
                transform: scale(1.06);
                z-index: 5;
            }
            .shiki-pill.active {
                background: #27ae60 !important;
                border-color: #2ecc71 !important;
                color: #ffffff !important;
                font-weight: bold;
            }
            .shiki-pill.active.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                font-weight: bold;
            }

            .shiki-hub-search-btn,
            .shiki-hub-catalog-btn,
            .btn-shiki-search-shortcut,
            .shiki-btn-load-more {
                transition: all 0.2s ease;
                outline: none !important;
            }
            .shiki-hub-search-btn.focus,
            .btn-shiki-search-shortcut.focus {
                background: #ffffff !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.03);
            }
            .shiki-hub-search-btn.focus *,
            .btn-shiki-search-shortcut.focus * {
                color: #000000 !important;
                fill: #000000 !important;
            }
            .shiki-hub-catalog-btn.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                box-shadow: 0 0 0 3px #ffffff, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.03);
            }
            .shiki-hub-catalog-btn.focus * {
                color: #000000 !important;
                fill: #000000 !important;
            }
            .shiki-btn-load-more.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                box-shadow: 0 0 0 3px #ffffff, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.04);
            }

            .shiki-ep-card {
                transition: all 0.15s ease;
                outline: none !important;
            }
            .shiki-ep-card.focus {
                background: #ffffff !important;
                color: #000000 !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 8px 20px rgba(0,0,0,0.8) !important;
                transform: scale(1.06);
                z-index: 5;
            }
            .shiki-ep-card.focus * {
                color: #000000 !important;
            }
            .shiki-ep-watched {
                border-color: rgba(46, 204, 113, 0.4) !important;
            }
            .shiki-ep-next {
                background: rgba(231, 76, 60, 0.2) !important;
                border-color: #e74c3c !important;
            }

            .shiki-status-badge {
                position: absolute;
                top: 0.5em;
                left: 0.5em;
                border-radius: 4px;
                padding: 0.2em 0.5em;
                font-size: 0.72em;
                font-weight: bold;
                color: #fff;
                z-index: 3;
                box-shadow: 0 2px 6px rgba(0,0,0,0.7);
                pointer-events: none;
                letter-spacing: 0.3px;
                white-space: nowrap;
            }
            .shiki-status--completed {
                background: rgba(39, 174, 96, 0.95) !important;
                border: 1px solid #2ecc71 !important;
                color: #fff !important;
            }
            .shiki-status--watching {
                background: rgba(41, 128, 185, 0.95) !important;
                border: 1px solid #3498db !important;
                color: #fff !important;
            }
            .shiki-status--planned {
                background: rgba(230, 126, 34, 0.95) !important;
                border: 1px solid #f39c12 !important;
                color: #fff !important;
            }
            .shiki-status--on_hold {
                background: rgba(127, 140, 141, 0.95) !important;
                border: 1px solid #bdc3c7 !important;
                color: #fff !important;
            }
            .shiki-status--rewatching {
                background: rgba(142, 68, 173, 0.95) !important;
                border: 1px solid #9b59b6 !important;
                color: #fff !important;
            }
            .shiki-status--dropped {
                background: rgba(192, 57, 43, 0.95) !important;
                border: 1px solid #e74c3c !important;
                color: #fff !important;
            }

            .shiki-filter-row {
                display: flex;
                align-items: center;
                gap: 0.8em;
                margin-bottom: 0.6em;
            }
            .shiki-filter-label {
                font-size: 0.85em;
                font-weight: bold;
                color: #aaa;
                min-width: 105px;
                flex-shrink: 0;
            }
            .shiki-filter-pills {
                display: flex;
                gap: 0.4em;
                flex-wrap: nowrap;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
                flex: 1;
                min-width: 0;
            }
            .shiki-filter-pills::-webkit-scrollbar {
                display: none;
            }

            /* Voice-over pills: one scrollable row, like the filter rows. */
            .shikimori-view__voices {
                display: flex;
                flex-wrap: nowrap;
                gap: 0.5em;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
            }
            .shikimori-view__voices::-webkit-scrollbar {
                display: none;
            }

            .shikimori-view__seasons {
                display: flex;
                flex-wrap: nowrap;
                gap: 0.5em;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
                margin-bottom: 1em;
            }
            .shikimori-view__seasons::-webkit-scrollbar {
                display: none;
            }

            .shikimori-view__header.focus {
                outline: 2px solid rgba(46, 204, 113, 0.65);
                outline-offset: 6px;
                border-radius: 12px;
            }

            /* Filter groups are compact chips that open Lampa's selectbox: one
               OK press instead of walking 40+ pills with the D-pad. */
            .shiki-filter-chip {
                display: inline-flex;
                align-items: baseline;
                gap: 0.45em;
                padding: 0.5em 0.9em;
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 8px;
                white-space: nowrap;
                max-width: 100%;
                cursor: pointer;
            }
            .shiki-filter-chip__label {
                color: #8a9099;
                font-size: 0.78em;
            }
            .shiki-filter-chip__value {
                color: #ffffff;
                font-size: 0.9em;
                font-weight: 600;
            }
            .shiki-filter-chip.focus {
                background: #ffffff !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 2px #2ecc71, 0 6px 16px rgba(0, 0, 0, 0.6) !important;
                transform: scale(1.03);
            }
            .shiki-filter-chip.focus .shiki-filter-chip__label,
            .shiki-filter-chip.focus .shiki-filter-chip__value {
                color: #000000 !important;
            }
        `;
        $('head').append('<style id="shikimori-plugin-styles">' + css + '</style>');
    }

    function createStatusBadge(animeId) {
        if (!animeId) return '';
        var rate = ShikiApi.getUserRate(animeId);
        if (rate && rate.status) {
            var text = '';
            switch (rate.status) {
                case 'completed':
                    text = '✓ Просмотрено';
                    break;
                case 'watching':
                    text = '▶ Смотрю' + (rate.episodes ? ' (' + rate.episodes + ')' : '');
                    break;
                case 'planned':
                    text = '⏱ В планах';
                    break;
                case 'on_hold':
                    text = '⏸ Отложено';
                    break;
                case 'rewatching':
                    text = '🔄 Смотрю снова';
                    break;
                case 'dropped':
                    text = '✖ Брошено';
                    break;
                default:
                    text = rate.status;
            }
            return '<div class="shiki-status-badge shiki-status--' + rate.status + '">' + text + '</div>';
        }

        if (ShikiApi.getLocalWatchedEpisodes) {
            var localEps = ShikiApi.getLocalWatchedEpisodes(animeId);
            if (localEps && localEps.length > 0) {
                return '<div class="shiki-status-badge shiki-status--watching">▶ Серия ' + localEps[localEps.length - 1] + '</div>';
            }
        }

        return '';
    }

    /**
     * Standard TV D-Pad Spatial Navigation Controller Binder
     */
    function setupTvController(scrollInstance, component, options) {
        options = options || {};
        var root = scrollInstance.render();
        var api = {
            get lastFocusElem() {
                return root.data('shiki-last-focus') || null;
            },
            setLastFocus: function (elem) {
                elem = elem instanceof jQuery ? elem[0] : elem;
                if (elem && document.contains(elem)) root.data('shiki-last-focus', elem);
            },
            focus: function (target) {
                var elem = target instanceof jQuery ? target[0] : target;
                if (!elem || !document.contains(elem)) return;
                root.data('shiki-last-focus', elem);
                if (!navigationAllowed(component)) return;
                navFocus(elem, root);
            },
            // Kept for the old call sites. Focus is handled from the page root
            // now, so adding a card needs no per-item wiring (and used to stack
            // another hover:focus handler on every render).
            attachToItem: function () {}
        };

        // Lampa dispatches hover:focus with bubbles = false (Utils.trigger), so a
        // delegated jQuery handler on the root never sees it. A capture-phase
        // native listener does, and still binds only once for dynamically added
        // cards. Without this the focus moved but the page/rows never scrolled.
        if (!root.data('shiki-tv-bound')) {
            root.data('shiki-tv-bound', true);
            root[0].addEventListener('hover:focus', function (event) {
                var elem = event.target;
                if (!elem || !elem.classList || !elem.classList.contains('selector')) return;
                root.data('shiki-last-focus', elem);
                // Only make the element visible: centering every single move made
                // the page jump around while browsing (Lampa does the same).
                if (scrollInstance.update) scrollInstance.update(elem);
                scrollRow(elem);
            }, true);
        }

        function move(direction, fallback) {
            var nav = getNavigator();
            if (nav && nav.canmove && nav.canmove(direction) && nav.move) {
                nav.move(direction);
            } else if (fallback) {
                fallback();
            }
        }

        var controller = {
            toggle: function () {
                if (!root || !root[0]) return;
                var remembered = root.data('shiki-last-focus');
                var target = remembered && document.contains(remembered) ? remembered : false;
                // visible_only: skip cards inside collapsed search results and
                // other hidden blocks, otherwise the focus could move onto them
                // and visually disappear.
                Lampa.Controller.collectionSet(root, false, true);
                Lampa.Controller.collectionFocus(target, root, true);
            },
            left: function () {
                move('left', function () { Lampa.Controller.toggle('menu'); });
            },
            right: function () {
                move('right');
            },
            up: function () {
                var nav = getNavigator();
                if (nav && nav.canmove && nav.canmove('up') && nav.move) {
                    nav.move('up');
                } else if (options.onUp) {
                    options.onUp();
                } else {
                    Lampa.Controller.toggle('head');
                }
            },
            down: function () {
                move('down');
            },
            // No enter override: Lampa's Controller.enter already triggers
            // hover:enter on the selected element exactly once. The old override
            // fired it twice, so OK opened every card/episode twice and Back had
            // to be pressed twice as well.
            back: function () {
                Lampa.Activity.backward();
            }
        };

        Lampa.Controller.add('content', controller);
        Lampa.Controller.toggle('content');

        return api;
    }

    function registerMenu() {
        function addMenuItem() {
            var menuList = $('.menu .menu__list').eq(0);
            if (!menuList.length) return;

            if (!$('.menu [data-action="shikimori_hub"]').length) {
                var menuBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_hub">
                        <div class="menu__ico">${SHIKI_ICON}</div>
                        <div class="menu__text">Shikimori</div>
                    </li>
                `);

                menuBtn.on('hover:enter', function () {
                    Lampa.Activity.push({
                        component: 'shikimori_hub',
                        title: 'Shikimori'
                    });
                });

                menuList.append(menuBtn);
            }

            if (!$('.menu [data-action="shikimori_catalog"]').length) {
                var catalogBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_catalog">
                        <div class="menu__ico"><svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/></svg></div>
                        <div class="menu__text">Каталог аниме</div>
                    </li>
                `);

                catalogBtn.on('hover:enter', function () {
                    Lampa.Activity.push({
                        component: 'shikimori_catalog',
                        title: 'Каталог аниме'
                    });
                });

                menuList.append(catalogBtn);
            }

            if (!$('.menu [data-action="shikimori_search"]').length) {
                var searchBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_search">
                        <div class="menu__ico"><svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg></div>
                        <div class="menu__text">Поиск аниме</div>
                    </li>
                `);

                searchBtn.on('hover:enter', function () {
                    // Input first, results immediately: no intermediate search
                    // page with an empty search bar.
                    if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                        ShikiKeyboard.open({
                            title: 'Поиск аниме на Shikimori',
                            value: '',
                            onDone: function (query) {
                                if (!query || !query.trim()) return;
                                query = query.trim();
                                Lampa.Activity.push({
                                    component: 'shikimori_search',
                                    title: 'Поиск: ' + query,
                                    query: query
                                });
                            }
                        });
                        return;
                    }

                    Lampa.Activity.push({
                        component: 'shikimori_search',
                        title: 'Поиск аниме'
                    });
                });

                menuList.append(searchBtn);
            }
        }

        addMenuItem();

        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('activity', function (e) {
                if (e.type === 'start') {
                    addMenuItem();
                }
            });
            Lampa.Listener.follow('menu', function (e) {
                if (e.type === 'end') {
                    addMenuItem();
                }
            });
        }
    }

    function registerFullCardButton() {
        if (!window.Lampa || !Lampa.Listener) return;
        Lampa.Listener.follow('full', function (e) {
            if (e && e.type === 'complite' && e.data && e.data.movie) {
                var movie = e.data.movie;
                var isAnime = false;

                if (movie.original_language === 'ja') isAnime = true;
                if (movie.genres && movie.genres.length) {
                    movie.genres.forEach(function (g) {
                        var name = (g.name || '').toLowerCase();
                        if (name.indexOf('аниме') >= 0 || name.indexOf('мультфильм') >= 0 || name.indexOf('animation') >= 0) {
                            if (movie.original_language === 'ja') isAnime = true;
                        }
                    });
                }

                if (isAnime) {
                    var shikiBtn = $(`
                        <div class="full-start__button selector view--shikimori" style="margin-left: 0.5em;">
                            ${SHIKI_ICON}
                            <span>Shikimori</span>
                        </div>
                    `);

                    shikiBtn.on('hover:enter', function () {
                        searchAndOpenAnime(movie);
                    });

                    var container = e.object && e.object.activity ? e.object.activity.render() : $('.full-start');

                    if (container.find('.view--shikimori').length) return;

                    var torrentBtn = container.find('.view--torrent');
                    if (torrentBtn.length) {
                        torrentBtn.after(shikiBtn);
                    } else {
                        var buttonsContainer = container.find('.full-start-new__buttons, .full-start__buttons');
                        if (buttonsContainer.length) {
                            buttonsContainer.append(shikiBtn);
                        } else {
                            container.append(shikiBtn);
                        }
                    }

                    // The button is injected after Lampa has built the focus
                    // collection for this card, so without appending it the remote
                    // could never reach it.
                    if (window.Lampa && Lampa.Controller && Lampa.Controller.collectionAppend) {
                        try { Lampa.Controller.collectionAppend(shikiBtn); } catch (e) {}
                    }
                }
            }
        });
    }

    function searchAndOpenAnime(movie) {
        if (!movie) return;
        var query = movie.original_name || movie.original_title || movie.name || movie.title;
        if (!query) {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Название аниме не определено');
            return;
        }

        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Поиск на Shikimori...', { time: 2000 });
        
        ShikiApi.searchAnime(query, 5, function (results) {
            if (results && results.length) {
                var best = results[0];
                Lampa.Activity.push({
                    component: 'shikimori_view',
                    title: best.russian || best.name,
                    anime: best
                });
            } else {
                if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Аниме не найдено на Shikimori', { time: 3000 });
            }
        }, function () {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Ошибка поиска на Shikimori', { time: 3000 });
        });
    }

    function registerComponents() {
        Lampa.Component.add('shikimori_hub', ShikimoriHubComponent);
        Lampa.Component.add('shikimori_view', ShikimoriViewComponent);
        Lampa.Component.add('shikimori_search', ShikimoriSearchComponent);
        Lampa.Component.add('shikimori_catalog', ShikimoriCatalogComponent);
    }

    /**
     * Shikimori Catalog Component with Advanced Filtering
     */
    function ShikimoriCatalogComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-catalog-page" style="padding: 1.5em 2.5em 6em 2.5em;"></div>');
        scroll.body().append(container);

        var activeFilters = {
            order: (object && object.order) || 'popularity',
            score: (object && object.score) || 'all',
            season: (object && object.season) || '2024_2026',
            genre: (object && object.genre) || 'all',
            status: (object && object.status) || 'all'
        };

        var currentPage = 1;
        var isLoading = false;
        var hasMore = true;
        var initialLoad = true;
        var tvCtrl = null;

        var filterGroups = [
            {
                key: 'order',
                label: 'Сортировка:',
                items: [
                    { id: 'popularity', title: '🔥 Популярное' },
                    { id: 'ranked', title: '⭐ Высокий рейтинг' },
                    { id: 'aired_on', title: '📅 Свежие новинки' },
                    { id: 'name', title: '🔤 По алфавиту' }
                ]
            },
            {
                key: 'score',
                label: 'Оценка:',
                items: [
                    { id: 'all', title: 'Любая' },
                    { id: '8', title: '★ 8+ (Шедевры)' },
                    { id: '7', title: '★ 7+ (Хорошие)' },
                    { id: '6', title: '★ 6+' }
                ]
            },
            {
                key: 'season',
                label: 'Год / Сезон:',
                items: [
                    { id: '2024_2026', title: '2024—2026' },
                    { id: '2026', title: '2026 год' },
                    { id: '2025', title: '2025 год' },
                    { id: '2024', title: '2024 год' },
                    { id: '2020_2023', title: '2020—2023' },
                    { id: '2010_2019', title: '2010—2019' },
                    { id: 'all', title: 'Все года' }
                ]
            },
            {
                key: 'genre',
                label: 'Жанр:',
                items: [
                    { id: 'all', title: 'Все жанры' },
                    { id: '1', title: 'Экшен' },
                    { id: '2', title: 'Приключения' },
                    { id: '4', title: 'Комедия' },
                    { id: '10', title: 'Фэнтези' },
                    { id: '24', title: 'Фантастика' },
                    { id: '8', title: 'Драма' },
                    { id: '22', title: 'Романтика' },
                    { id: '7', title: 'Детектив' },
                    { id: '41', title: 'Триллер' },
                    { id: '36', title: 'Повседневность' },
                    { id: '37', title: 'Сверхъестественное' },
                    { id: '27', title: 'Сёнен' },
                    { id: '42', title: 'Сэйнэн' },
                    { id: '30', title: 'Спорт' },
                    { id: '18', title: 'Меха' },
                    { id: '14', title: 'Ужасы' }
                ]
            },
            {
                key: 'status',
                label: 'Статус:',
                items: [
                    { id: 'all', title: 'Все' },
                    { id: 'ongoing', title: 'Онгоинги (выходят)' },
                    { id: 'released', title: 'Завершённые' },
                    { id: 'anons', title: 'Анонсы' }
                ]
            }
        ];

        var headerElem = $(`
            <div class="shiki-catalog-header" style="margin-bottom: 1.2em;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8em; flex-wrap: wrap; gap: 0.8em;">
                    <div style="font-size: 1.5em; font-weight: bold; margin: 0; display: flex; align-items: center; gap: 0.5em; color: #fff;">
                        ${SHIKI_ICON} Каталог аниме с фильтрами
                    </div>
                    <div class="selector btn-shiki-search-shortcut" style="padding: 0.5em 1.2em; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; gap: 0.6em; color: #eee;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                        <span>Поиск по названию</span>
                    </div>
                </div>
                <div class="shiki-catalog-filters" style="background: rgba(0,0,0,0.35); padding: 0.8em 1em; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 1.2em;"></div>
            </div>
        `);

        headerElem.find('.btn-shiki-search-shortcut').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: '',
                    onDone: function (q) {
                        if (q && q.trim()) {
                            Lampa.Activity.push({
                                component: 'shikimori_search',
                                title: 'Поиск: ' + q.trim(),
                                query: q.trim()
                            });
                        }
                    }
                });
                return;
            }
            Lampa.Activity.push({
                component: 'shikimori_search',
                title: 'Поиск аниме'
            });
        });

        var filtersContainer = headerElem.find('.shiki-catalog-filters');
        filtersContainer.css({ display: 'flex', flexWrap: 'wrap', gap: '0.5em' });

        filterGroups.forEach(function (group) {
            var chip = $('<div class="selector shiki-filter-chip"></div>');

            function currentItem() {
                for (var i = 0; i < group.items.length; i++) {
                    if (group.items[i].id === activeFilters[group.key]) return group.items[i];
                }
                return group.items[0];
            }

            function paintChip() {
                var picked = currentItem();
                chip.html(
                    '<span class="shiki-filter-chip__label">' + group.label + '</span>' +
                    '<span class="shiki-filter-chip__value">' + picked.title + '</span>'
                );
            }

            function applyFilter(value) {
                if (value === activeFilters[group.key]) return;
                activeFilters[group.key] = value;
                paintChip();
                currentPage = 1;
                hasMore = true;
                retryLoad = false;
                gridContainer.empty();
                // Drop the removed cards from the navigation collection right
                // away; otherwise the D-pad can move into detached posters while
                // the new page is still loading.
                if (window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    if (tvCtrl && tvCtrl.lastFocusElem && document.contains(tvCtrl.lastFocusElem)) {
                        tvCtrl.focus(tvCtrl.lastFocusElem);
                    }
                }
                loadPage(true);
            }

            chip.on('hover:enter', function () {
                // One chip per filter group opening Lampa's own selectbox: on a
                // remote that is a few presses instead of walking dozens of pills
                // across five rows.
                if (window.Lampa && Lampa.Select && Lampa.Select.show) {
                    var previous = enabledControllerName();
                    var items = group.items.map(function (item) {
                        return {
                            title: item.title,
                            value: item.id,
                            selected: item.id === activeFilters[group.key]
                        };
                    });

                    Lampa.Select.show({
                        title: group.label.replace(/:$/, ''),
                        items: items,
                        onSelect: function (element) {
                            restoreController(previous);
                            applyFilter(element.value);
                        },
                        onBack: function () {
                            restoreController(previous);
                        }
                    });
                    return;
                }

                // Old Lampa without selectbox: cycle through the values on OK.
                var items = group.items;
                var idx = 0;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].id === activeFilters[group.key]) idx = i;
                }
                applyFilter(items[(idx + 1) % items.length].id);
            });

            paintChip();
            filtersContainer.append(chip);
        });

        var gridContainer = $('<div class="category-full shiki-catalog-grid"></div>');
        var loadMoreBtn = $(`
            <div class="selector shiki-btn-load-more" style="width: 100%; box-sizing: border-box; padding: 0.9em 2em; text-align: center; background: rgba(46, 204, 113, 0.15); border: 1px solid rgba(46, 204, 113, 0.5); color: #2ecc71; font-weight: bold; border-radius: 8px; cursor: pointer; margin: 1.5em 0;">
                Загрузить ещё аниме
            </div>
        `);

        var retryLoad = false;

        loadMoreBtn.on('hover:enter', function () {
            if (isLoading || !hasMore) return;
            if (retryLoad) {
                retryLoad = false;
                loadPage(false, true);
                return;
            }
            currentPage++;
            loadPage(false, true);
        });

        container.append(headerElem);
        container.append(gridContainer);
        container.append(loadMoreBtn);

        function loadPage(reset, focusNew) {
            if (isLoading) return;
            isLoading = true;
            retryLoad = false;
            loadMoreBtn.text('Загрузка аниме...').css('opacity', '0.6');

            ShikiApi.getCatalog(activeFilters, currentPage, 30, function (results) {
                isLoading = false;
                loadMoreBtn.css('opacity', '1');

                if (!results || !results.length) {
                    hasMore = false;
                    loadMoreBtn.text('Все аниме загружены').hide();
                    if (currentPage === 1) {
                        gridContainer.html('<div style="grid-column: 1 / -1; text-align: center; padding: 3em; color: #e74c3c; font-size: 1.1em;">По выбранным фильтрам ничего не найдено. Попробуйте изменить параметры.</div>');
                    }
                    return;
                }

                if (results.length < 30) {
                    hasMore = false;
                    loadMoreBtn.hide();
                } else {
                    hasMore = true;
                    loadMoreBtn.text('Загрузить ещё аниме (Стр. ' + (currentPage + 1) + ')').show();
                }

                var batch = document.createDocumentFragment();
                var newCards = [];

                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);
                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector card--category shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    batch.appendChild(card[0]);
                    newCards.push(card[0]);
                });

                // One DOM insertion for the whole page instead of one reflow per card.
                gridContainer[0].appendChild(batch);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                // On a fresh page we rebuild the collection; on "load more" we
                // only append the new cards. collectionSet() clears the current
                // selection, which was exactly why the focus disappeared and
                // the D-pad jumped to the top/bottom after loading a page.
                var firstPage = initialLoad;
                initialLoad = false;
                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    if (reset || firstPage) {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                        if (firstPage && tvCtrl) {
                            var firstCard = gridContainer.find('.selector').first();
                            if (firstCard.length) tvCtrl.focus(firstCard);
                        } else if (tvCtrl) {
                            // Filter reload: stay on the filter chip the user has
                            // just used instead of dropping the highlight.
                            var remembered = tvCtrl.lastFocusElem;
                            if (remembered && document.contains(remembered)) tvCtrl.focus(remembered);
                        }
                    } else if (Lampa.Controller.collectionAppend) {
                        Lampa.Controller.collectionAppend(newCards);
                        var focusedNow = document.querySelector('.selector.focus');
                        var buttonFocused = focusedNow && focusedNow === loadMoreBtn[0];
                        // Auto-load can happen while the "load more" button is
                        // focused; after appending, that button moves below the
                        // new rows and the highlight disappears off-screen.
                        if (tvCtrl && newCards.length && (focusNew || buttonFocused || !focusedNow)) {
                            tvCtrl.focus(newCards[0]);
                        }
                    } else {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                    }
                }

            }, function (err) {
                isLoading = false;
                retryLoad = true;
                loadMoreBtn.text('Ошибка загрузки. Нажмите чтобы повторить').css('opacity', '1');
            });
        }

        scroll.onEnd = function () {
            if (isActive(self) && !isLoading && hasMore && !retryLoad) {
                currentPage++;
                loadPage(false, false);
            }
        };

        this.create = function () {
            loadPage(true);
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        this.destroy = function () {
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
        };
    }

    /**
     * Standalone Shikimori Search Component
     */
    function ShikimoriSearchComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-search-page" style="padding: 1.5em 2em 3em 2em;"></div>');
        scroll.body().append(container);

        var query = (object && object.query) || '';
        var tvCtrl = null;

        var searchBar = $(`
            <div style="margin-bottom: 2em;">
                <div class="selector shiki-hub-search-btn" style="height: 52px; box-sizing: border-box; display: flex; align-items: center; gap: 0.9em; padding: 0 1.4em; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; cursor: pointer;">
                    <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="#2ecc71"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                    <span class="shiki-search-label" style="color: #eee; font-size: 1.05em; font-weight: 500;">${query ? ('Поиск: «' + query + '» (нажмите для изменения)') : 'Нажмите для ввода названия аниме с пульта...'}</span>
                </div>
                <div class="shiki-search-grid-box" style="margin-top: 1.5em;"></div>
            </div>
        `);
        container.append(searchBar);

        searchBar.find('.shiki-hub-search-btn').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: query || '',
                    onDone: function (newQ) {
                        if (newQ && newQ.trim()) {
                            query = newQ.trim();
                            searchBar.find('.shiki-search-label').text('Поиск: «' + query + '» (нажмите для изменения)');
                            doSearch();
                        }
                    }
                });
                return;
            }

            if (window.Lampa && Lampa.Input) {
                Lampa.Input.edit({
                    title: 'Поиск аниме на Shikimori',
                    value: query || '',
                    free: true,
                    nosave: true,
                    nomic: true
                }, function (newQ) {
                    if (newQ && newQ.trim()) {
                        query = newQ.trim();
                        searchBar.find('.shiki-search-label').text('Поиск: «' + query + '» (нажмите для изменения)');
                        doSearch();
                    }
                });
            }
        });

        function doSearch() {
            var gridBox = searchBar.find('.shiki-search-grid-box');
            gridBox.html('<div style="text-align: center; padding: 2em; color: #aaa;">Поиск на Shikimori...</div>');

            ShikiApi.searchAnime(query, 50, function (results) {
                gridBox.empty();
                if (!results || !results.length) {
                    gridBox.html('<div style="color: #e74c3c; text-align: center; padding: 2em; font-size: 1.1em;">По запросу «' + query + '» ничего не найдено на Shikimori</div>');
                    return;
                }

                var grid = $('<div class="category-full shiki-catalog-grid"></div>');
                var batch = document.createDocumentFragment();
                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);
                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector card--category shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    batch.appendChild(card[0]);
                });
                grid[0].appendChild(batch);

                gridBox.append(grid);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    var firstCard = grid.find('.selector').first();
                    if (firstCard.length && tvCtrl) tvCtrl.focus(firstCard);
                }
            }, function (err) {
                gridBox.html('<div style="color: #e74c3c; text-align: center; padding: 2em;">Ошибка поиска: ' + err + '</div>');
            });
        }

        this.create = function () {
            if (query) {
                doSearch();
            } else {
                setTimeout(function () {
                    // Do not open the keyboard over whatever the user moved on to.
                    if (!isActive(self)) return;
                    searchBar.find('.shiki-hub-search-btn').trigger('hover:enter');
                }, 300);
            }
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        this.destroy = function () {
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
            var searchBtn = searchBar.find('.shiki-hub-search-btn');
            if (searchBtn.length && !query && tvCtrl) {
                tvCtrl.focus(searchBtn);
            }
        };
    }

    /**
     * Shikimori Hub Component
     */
    function ShikimoriHubComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-hub-container" style="padding: 1.5em 2.5em 6em 2.5em;"></div>');
        scroll.body().append(container);

        var lastSearchQuery = '';
        var initialRender = true;
        var tvCtrl = null;

        var searchWrapper = $(`
            <div class="shiki-search-wrapper" style="margin-bottom: 2em;">
                <div style="display: flex; gap: 1em; align-items: center; flex-wrap: wrap;">
                    <div class="selector shiki-hub-search-btn" style="flex: 1; min-width: 260px; height: 50px; box-sizing: border-box; display: flex; align-items: center; gap: 0.9em; padding: 0 1.3em; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; cursor: pointer;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="#2ecc71"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                        <span class="shiki-hub-search-text" style="color: #eee; font-size: 1.05em; font-weight: 500;">Поиск аниме по названию...</span>
                    </div>
                    <div class="selector shiki-hub-catalog-btn" style="height: 50px; box-sizing: border-box; display: flex; align-items: center; gap: 0.6em; padding: 0 1.5em; background: #27ae60; color: #fff; font-weight: bold; border-radius: 8px; cursor: pointer;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/></svg>
                        <span>Каталог с фильтрами</span>
                    </div>
                </div>
                <div class="shiki-search-results-area" style="display: none; margin-top: 1.5em;"></div>
            </div>
        `);
        var contentWrapper = $('<div class="shiki-content-wrapper"></div>');

        container.append(searchWrapper);
        container.append(contentWrapper);

        searchWrapper.find('.shiki-hub-catalog-btn').on('hover:enter', function () {
            Lampa.Activity.push({
                component: 'shikimori_catalog',
                title: 'Каталог аниме'
            });
        });

        searchWrapper.find('.shiki-hub-search-btn').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: lastSearchQuery || '',
                    onDone: function (query) {
                        if (query && query.trim()) {
                            executeHubSearch(query.trim());
                        }
                    }
                });
                return;
            }

            if (window.Lampa && Lampa.Input) {
                Lampa.Input.edit({
                    title: 'Поиск аниме на Shikimori',
                    value: lastSearchQuery || '',
                    free: true,
                    nosave: true,
                    nomic: true
                }, function (query) {
                    if (query && query.trim()) {
                        executeHubSearch(query.trim());
                    }
                });
            }
        });

        function executeHubSearch(query) {
            lastSearchQuery = query;
            var resultsArea = searchWrapper.find('.shiki-search-results-area');
            resultsArea.show().html('<div style="color: #aaa; padding: 1.5em 0; text-align: center;">Поиск «' + query + '» в Shikimori...</div>');

            ShikiApi.searchAnime(query, 30, function (results) {
                resultsArea.empty();

                if (!results || !results.length) {
                    resultsArea.html(`
                        <div style="padding: 1em 0; display: flex; justify-content: space-between; align-items: center;">
                            <div style="color: #e74c3c;">По запросу «${query}» ничего не найдено на Shikimori</div>
                            <div class="selector shiki-btn-close-search" style="padding: 0.4em 0.8em; background: rgba(255,255,255,0.1); border-radius: 6px; cursor: pointer; font-size: 0.85em;">✖ Закрыть поиск</div>
                        </div>
                    `);
                    resultsArea.find('.shiki-btn-close-search').on('hover:enter', function () {
                        resultsArea.empty().hide();
                        if (tvCtrl) tvCtrl.focus(searchWrapper.find('.shiki-hub-search-btn'));
                    });
                    if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                        tvCtrl && tvCtrl.focus(resultsArea.find('.shiki-btn-close-search').first());
                    }
                    return;
                }

                var searchHeader = $(`
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1em;">
                        <h2 style="font-size: 1.3em; font-weight: bold; margin: 0; color: #fff;">
                            Результаты поиска: «${query}» <span style="font-size: 0.8em; color: #888; font-weight: normal;">(${results.length})</span>
                        </h2>
                        <div class="selector shiki-btn-close-search" style="padding: 0.4em 0.9em; background: rgba(255,255,255,0.12); border-radius: 6px; cursor: pointer; font-size: 0.85em; font-weight: bold; color: #e74c3c;">
                            ✖ Сбросить поиск
                        </div>
                    </div>
                `);

                searchHeader.find('.shiki-btn-close-search').on('hover:enter', function () {
                    resultsArea.empty().hide();
                    if (tvCtrl) tvCtrl.focus(searchWrapper.find('.shiki-hub-search-btn'));
                });

                var cardsContainer = $('<div class="shiki-hub-cards" style="display: flex; gap: 1em; overflow-x: auto; padding-bottom: 1em; scrollbar-width: thin;"></div>');

                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);

                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    if (tvCtrl) tvCtrl.attachToItem(card);
                    cardsContainer.append(card);
                });

                resultsArea.append(searchHeader);
                resultsArea.append(cardsContainer);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    var firstSearchCard = resultsArea.find('.selector.shiki-card').first();
                    if (firstSearchCard.length && tvCtrl) {
                        tvCtrl.focus(firstSearchCard);
                    }
                }
            }, function (err) {
                resultsArea.html('<div style="color: #e74c3c; padding: 1em 0;">Ошибка поиска: ' + (err || 'сеть недоступна') + '</div>');
            });
        }

        this.create = function () {
            if (object.activity && object.activity.loader) object.activity.loader(true);
            loadCategories();
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        var refreshTimer = null;
        var onProgressUpdated = function () {
            // The hub is often buried under the view or the player when progress
            // changes. Reloading it there used to re-collect the global Navigator
            // collection of a hidden page and broke the D-pad on the visible one.
            if (!isActive(self)) return;
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(function () {
                if (isActive(self)) loadCategories();
            }, 600);
        };
        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('shikimori_progress_updated', onProgressUpdated);
        }

        this.destroy = function () {
            clearTimeout(refreshTimer);
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.remove('shikimori_progress_updated', onProgressUpdated);
            }
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
        };

        function loadDiscoveryRows(callback) {
            if (discoveryCache.rows && Date.now() - discoveryCache.at < DISCOVERY_TTL) {
                callback(discoveryCache.rows);
                return;
            }

            var discoveryDefs = [
                { title: '🔥 Популярные новинки (2024—2026)', filters: { order: 'popularity', season: '2024_2026' } },
                { title: '⭐ Лучшее аниме (Рейтинг 8+)', filters: { order: 'ranked', score: 8 } },
                { title: '📺 Популярные онгоинги', filters: { order: 'popularity', status: 'ongoing' } }
            ];

            var rows = new Array(discoveryDefs.length);
            var remaining = discoveryDefs.length;

            function done() {
                var result = rows.filter(Boolean);
                discoveryCache = { at: Date.now(), rows: result };
                callback(result);
            }

            discoveryDefs.forEach(function (def, defIndex) {
                ShikiApi.getCatalog(def.filters, 1, 12, function (list) {
                    if (Array.isArray(list) && list.length) {
                        var items = list.map(function (a) {
                            return {
                                id: a.id,
                                title: a.russian || a.name,
                                original_title: a.name,
                                poster_path: ShikiApi.fixImageUrl(a.image ? (a.image.original || a.image.preview) : ''),
                                vote_average: a.score,
                                episodes_total: a.episodes,
                                episodes_watched: 0,
                                anime_raw: a
                            };
                        });
                        rows[defIndex] = {
                            title: def.title,
                            id: 'discovery_' + def.filters.order + '_' + defIndex,
                            items: items
                        };
                    }
                    remaining--;
                    if (remaining <= 0) done();
                }, function () {
                    remaining--;
                    if (remaining <= 0) done();
                });
            });
        }

        function loadCategories() {
            var userRows = [];

            function finish(allRows) {
                if (ShikiApi.getLocalHistory) {
                    var localHist = ShikiApi.getLocalHistory();
                    if (localHist && localHist.length) {
                        var histItems = localHist.map(function (item) {
                            return {
                                id: item.id,
                                title: item.title,
                                original_title: item.name,
                                poster_path: ShikiApi.fixImageUrl(item.poster_path || (item.image ? (item.image.original || item.image.preview) : '')),
                                vote_average: item.vote_average,
                                episodes_total: item.episodes_total,
                                episodes_watched: item.lastEpisode,
                                anime_raw: item
                            };
                        });
                        allRows.unshift({
                            title: '🕒 История просмотров',
                            id: 'local_history',
                            items: histItems
                        });
                    }
                }

                if (object.activity && object.activity.loader) object.activity.loader(false);
                renderRows(allRows);
            }

            if (!ShikiApi.isAuthorized()) {
                loadDiscoveryRows(function (discRows) {
                    finish(discRows);
                });
                return;
            }

            var categories = [
                { id: 'watching', title: 'Смотрю' },
                { id: 'planned', title: 'В планах' },
                { id: 'rewatching', title: 'Пересматриваю' },
                { id: 'completed', title: 'Просмотрено' },
                { id: 'on_hold', title: 'Отложено' }
            ];

            var pending = categories.length;

            categories.forEach(function (cat) {
                ShikiApi.getUserRates(cat.id, 1, 15, function (rates) {
                    var items = [];
                    if (Array.isArray(rates)) {
                        rates.forEach(function (r) {
                            if (r.anime) {
                                items.push({
                                    id: r.anime.id,
                                    title: r.anime.russian || r.anime.name,
                                    original_title: r.anime.name,
                                    poster_path: ShikiApi.fixImageUrl(r.anime.image ? (r.anime.image.original || r.anime.image.preview) : ''),
                                    vote_average: r.anime.score,
                                    episodes_total: r.anime.episodes,
                                    episodes_watched: r.episodes,
                                    rate_id: r.id,
                                    rate_status: r.status,
                                    anime_raw: r.anime
                                });
                            }
                        });
                    }

                    if (items.length) {
                        userRows.push({
                            title: cat.title,
                            id: cat.id,
                            items: items
                        });
                    }

                    pending--;
                    if (pending <= 0) {
                        loadDiscoveryRows(function (discRows) {
                            finish(userRows.concat(discRows));
                        });
                    }
                }, function () {
                    pending--;
                    if (pending <= 0) {
                        loadDiscoveryRows(function (discRows) {
                            finish(userRows.concat(discRows));
                        });
                    }
                });
            });
        }

        function renderRows(rows) {
            contentWrapper.empty();

            if (!ShikiApi.isAuthorized()) {
                showAuthPrompt();
            }

            if (!rows.length) {
                if (ShikiApi.isAuthorized()) {
                    contentWrapper.append('<div style="text-align: center; padding: 3em; color: #aaa;">Ваши списки на Shikimori пусты</div>');
                }
                return;
            }

            var rowsFragment = document.createDocumentFragment();

            rows.forEach(function (rowObj) {
                var rowElem = $(`
                    <div class="shiki-hub-row" style="margin-bottom: 2em;">
                        <h2 style="font-size: 1.3em; font-weight: bold; margin-bottom: 0.8em; display: flex; align-items: center; gap: 0.5em; color: #fff;">
                            ${rowObj.title} <span style="font-size: 0.8em; color: #888; font-weight: normal;">(${rowObj.items.length})</span>
                        </h2>
                        <div class="shiki-hub-cards"></div>
                    </div>
                `);

                var cardsContainer = rowElem.find('.shiki-hub-cards');

                rowObj.items.forEach(function (item) {
                    var statusBadge = createStatusBadge(item.id);
                    var epCount = item.episodes_watched ? (item.episodes_watched + ' / ' + (item.episodes_total || '?') + ' эп.') : (item.episodes_total ? (item.episodes_total + ' эп.') : '');
                    var card = $(`
                        <div class="card selector shiki-card">
                            <div class="card__view">
                                <img src="${item.poster_path}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${item.episodes_watched ? `<div class="shiki-badge">${item.episodes_watched} / ${item.episodes_total || '?'}</div>` : (item.episodes_total ? `<div class="shiki-badge">${item.episodes_total} эп.</div>` : '')}
                                ${item.vote_average && parseFloat(item.vote_average) > 0 ? `<div class="shiki-score">★ ${item.vote_average}</div>` : ''}
                            </div>
                            <div class="card__title" title="${item.title}">
                                ${item.title}
                            </div>
                            <div class="card__age">
                                ${epCount}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: item.title,
                            anime: item.anime_raw,
                            rateId: item.rate_id,
                            episodesWatched: item.episodes_watched
                        });
                    });

                    if (tvCtrl) tvCtrl.attachToItem(card);
                    cardsContainer.append(card);
                });

                rowsFragment.appendChild(rowElem[0]);
            });

            // Single insertion for all rows: avoids a reflow per row.
            contentWrapper[0].appendChild(rowsFragment);

            if (window.Lampa && Lampa.Layer) {
                Lampa.Layer.update(scroll.render());
            }

            // Keep the current card focused when the rows are rebuilt (progress
            // sync, returning from an activity); only pick the first card when
            // nothing inside the hub is focused yet.
            var firstRender = initialRender;
            initialRender = false;
            if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                Lampa.Controller.collectionSet(scroll.render(), false, true);
                if (firstRender || !scroll.render().find('.selector.focus').length) {
                    var firstElem = contentWrapper.find('.card').first();
                    if (!firstElem.length) firstElem = contentWrapper.find('.selector').first();
                    if (!firstElem.length) firstElem = searchWrapper.find('.selector').first();
                    if (firstElem.length && tvCtrl) {
                        tvCtrl.focus(firstElem);
                    }
                }
            }
        }

        function showAuthPrompt() {
            var html = $(`
                <div class="shiki-hub-auth-prompt" style="padding: 0.9em 1.4em; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); border-radius: 8px; margin-bottom: 1.5em; border: 1px dashed rgba(255,255,255,0.18); flex-wrap: wrap; gap: 0.8em;">
                    <div>
                        <div style="font-size: 1.1em; font-weight: bold; color: #fff;">Вход в аккаунт Shikimori</div>
                        <div style="color: #aaa; font-size: 0.85em; margin-top: 0.1em;">Синхронизация списков «Смотрю», «В планах» и авто-запись серий</div>
                    </div>
                    <div class="selector btn-shiki-login" style="padding: 0.55em 1.4em; background: #2ecc71; color: #fff; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 0.9em;">
                        Войти в аккаунт
                    </div>
                </div>
            `);

            html.find('.btn-shiki-login').on('hover:enter', function () {
                ShikiSettings.openAuthModal();
            });

            if (tvCtrl) tvCtrl.attachToItem(html.find('.btn-shiki-login'));
            contentWrapper.prepend(html);
        }
    }

    /**
     * Anime View Component
     */
    function ShikimoriViewComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var anime = object.anime || {};
        var translations = [];
        var activeTranslation = 0;
        var activeSeason = 1;
        var episodesWatched = object.episodesWatched || 0;
        var rateId = object.rateId || null;
        var tvCtrl = null;

        var view = $(`
            <div class="shikimori-view" style="padding: 1.5em 2.5em 8em 2.5em;">
                <div class="shikimori-view__header selector" style="display: flex; gap: 1.5em; margin-bottom: 1.5em;">
                    <img class="shikimori-view__poster" style="width: 150px; height: 220px; border-radius: 8px; object-fit: cover; box-shadow: 0 4px 14px rgba(0,0,0,0.6);" />
                    <div class="shikimori-view__info" style="flex: 1;">
                        <h2 class="shikimori-view__title" style="margin: 0 0 0.2em 0; font-size: 1.8em; color: #fff;"></h2>
                        <div class="shikimori-view__subtitle" style="color: #aaa; margin-bottom: 0.5em; font-size: 1em;"></div>
                        <div class="shikimori-view__user-status" style="margin-bottom: 0.5em;"></div>
                        <div class="shikimori-view__meta" style="color: #2ecc71; font-weight: bold; margin-bottom: 0.8em;"></div>
                        <div class="shikimori-view__desc" style="color: #ddd; font-size: 0.9em; line-height: 1.4; max-height: 5em; overflow: hidden;"></div>
                    </div>
                </div>

                <div style="font-weight: bold; margin-bottom: 0.5em; color: #aaa;">Озвучка:</div>
                <div class="shikimori-view__voices shiki-filter-row" style="margin-bottom: 1.2em;"></div>

                <div class="shikimori-view__seasons" style="display: none;"></div>

                <h3 style="margin: 1em 0 0.6em 0; color: #fff;">Серии:</h3>
                <div class="shikimori-view__episodes" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.7em;"></div>
            </div>
        `);

        scroll.body().append(view);

        this.create = function () {
            if (self.activity && self.activity.loader) self.activity.loader(true);
            else if (object.activity && object.activity.loader) object.activity.loader(true);
            setupHeader();

            if (!anime.description && anime.id) {
                ShikiApi.getAnime(anime.id, function (fullData) {
                    if (fullData) {
                        anime.description = fullData.description || anime.description;
                        anime.score = fullData.score || anime.score;
                        anime.episodes = fullData.episodes || anime.episodes;
                        setupHeader();
                    }
                });
            }

            loadAnimeStreams();
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        var onProgressUpdated = function (e) {
            if (e && String(e.animeId) === String(anime.id) && isActive(self)) {
                setupHeader();
                renderEpisodes();
            }
        };
        var onActivityEvent = function (e) {
            if (e && e.type === 'active' && isActive(self)) {
                setupHeader();
                renderEpisodes();
            }
        };
        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('shikimori_progress_updated', onProgressUpdated);
            Lampa.Listener.follow('activity', onActivityEvent);
        }

        this.destroy = function () {
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.remove('shikimori_progress_updated', onProgressUpdated);
                Lampa.Listener.remove('activity', onActivityEvent);
            }
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self, {
                onUp: function () {
                    var root = scroll.render()[0];
                    var body = root.querySelector('.scroll__body');
                    var header = view.find('.shikimori-view__header')[0];
                    var rootTop = root.getBoundingClientRect().top;
                    var bodyTop = body ? body.getBoundingClientRect().top : rootTop;

                    // At the topmost focusable row (voices/seasons): first scroll
                    // the poster back into view, and only the next Up goes to the
                    // fixed top bar. Without this the poster stayed off-screen.
                    if (header && bodyTop < rootTop - 10) {
                        scroll.update(header);
                    } else {
                        Lampa.Controller.toggle('head');
                    }
                }
            });
        };

        function setupHeader() {
            view.find('.shikimori-view__title').text(anime.russian || anime.name);
            view.find('.shikimori-view__subtitle').text(anime.name + (anime.aired_on ? ' • ' + anime.aired_on.split('-')[0] : ''));
            view.find('.shikimori-view__meta').text('★ ' + (anime.score || '-') + ' • Всего серий: ' + (anime.episodes || anime.episodes_aired || '?'));
            
            var rawDesc = anime.description || '';
            var cleanDesc = rawDesc
                .replace(/\[\/?(character|anime|manga|person|b|i|u|s|url|quote|spoiler)[^\]]*\]/gi, '')
                .replace(/\r\n|\r|\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            view.find('.shikimori-view__desc').text(cleanDesc);

            var userRate = ShikiApi.getUserRate(anime.id);
            var statusBox = view.find('.shikimori-view__user-status');
            statusBox.empty();

            if (userRate && userRate.status) {
                var statusNames = {
                    completed: '✓ Просмотрено',
                    watching: '▶ Смотрю',
                    planned: '⏱ В планах',
                    on_hold: '⏸ Отложено',
                    rewatching: '🔄 Пересматриваю',
                    dropped: '✖ Брошено'
                };
                var sName = statusNames[userRate.status] || userRate.status;
                var epInfo = (userRate.episodes !== undefined && userRate.episodes !== null) ? (' • Просмотрено: ' + userRate.episodes + ' из ' + (anime.episodes || anime.episodes_aired || '?') + ' сер.') : '';
                var scInfo = userRate.score ? (' • Ваша оценка: ★ ' + userRate.score + '/10') : '';
                statusBox.html(`
                    <div class="shiki-status-badge shiki-status--${userRate.status}" style="position: static; display: inline-block; font-size: 0.85em; padding: 0.35em 0.8em; margin-bottom: 0.4em;">
                        ${sName}${epInfo}${scInfo}
                    </div>
                `);
            } else if (ShikiApi.getLocalWatchedEpisodes) {
                var localEps = ShikiApi.getLocalWatchedEpisodes(anime.id);
                if (localEps && localEps.length > 0) {
                    var lastEp = localEps[localEps.length - 1];
                    var isAll = anime.episodes && localEps.length >= anime.episodes;
                    var label = isAll ? '✓ Просмотрено полностью' : ('▶ Смотрю • Просмотрено серий: ' + localEps.length + ' из ' + (anime.episodes || '?') + ' (последняя: ' + lastEp + ')');
                    statusBox.html(`
                        <div class="shiki-status-badge shiki-status--${isAll ? 'completed' : 'watching'}" style="position: static; display: inline-block; font-size: 0.85em; padding: 0.35em 0.8em; margin-bottom: 0.4em;">
                            ${label}
                        </div>
                    `);
                }
            }

            var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
            view.find('.shikimori-view__poster').attr('src', posterUrl);
        }

        function loadAnimeStreams() {
            var allTrans = [];

            function onTranslationsLoaded() {
                translations = allTrans;
                renderVoicesAndEpisodes();
            }

            function searchByTitleFallback() {
                var title = anime.russian || anime.name;
                if (!title) {
                    tryAniLibriaFallback();
                    return;
                }
                KodikBalancer.searchByTitle(title, function (titleResults) {
                    if (titleResults && titleResults.length) {
                        allTrans = titleResults;
                        onTranslationsLoaded();
                    } else {
                        tryAniLibriaFallback();
                    }
                }, function () {
                    tryAniLibriaFallback();
                });
            }

            function tryAniLibriaFallback() {
                var title = anime.russian || anime.name;
                if (!title) {
                    showStreamError();
                    return;
                }
                AniLibriaBalancer.search(title, function (anilibriaResults) {
                    if (anilibriaResults && anilibriaResults.length) {
                        allTrans = anilibriaResults;
                        onTranslationsLoaded();
                    } else {
                        showStreamError();
                    }
                }, function () {
                    showStreamError();
                });
            }

            function showStreamError() {
                if (self.activity && self.activity.loader) self.activity.loader(false);
                else if (object.activity && object.activity.loader) object.activity.loader(false);
                view.find('.shikimori-view__episodes').html('<div style="color: #e74c3c; padding: 1em;">Не удалось найти видеопотоки для этого тайтла.</div>');
            }

            if (anime.id) {
                KodikBalancer.searchByShikimoriId(anime.id, function (kodikResults) {
                    if (kodikResults && kodikResults.length) {
                        allTrans = kodikResults;
                        onTranslationsLoaded();
                    } else {
                        searchByTitleFallback();
                    }
                }, function () {
                    searchByTitleFallback();
                });
            } else {
                searchByTitleFallback();
            }
        }

        function seasonKeys(trans) {
            var seasons = (trans && trans.seasons) || {};
            var keys = Object.keys(seasons);
            keys.sort(function (a, b) {
                return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
            });
            return keys;
        }

        function renderSeasons() {
            var container = view.find('.shikimori-view__seasons');
            container.empty();

            var currentTrans = translations[activeTranslation];
            var keys = seasonKeys(currentTrans);

            if (keys.length <= 1) {
                if (keys.length === 1) activeSeason = parseInt(keys[0], 10) || 1;
                container.hide();
                return;
            }

            if (keys.indexOf(String(activeSeason)) === -1) {
                activeSeason = parseInt(keys[0], 10) || 1;
            }

            container.show();

            keys.forEach(function (key) {
                var num = parseInt(key, 10) || 1;
                var btn = $('<div class="shiki-pill selector' + (num === activeSeason ? ' active' : '') + '">Сезон ' + num + '</div>');

                btn.on('hover:enter', function () {
                    if (num === activeSeason) return;
                    activeSeason = num;
                    container.find('.shiki-pill').removeClass('active');
                    btn.addClass('active');
                    // Stay on the season pill; only the episode grid changes.
                    renderEpisodes({ focus: false });
                });

                container.append(btn);
            });
        }

        function renderVoicesAndEpisodes() {
            if (self.activity && self.activity.loader) self.activity.loader(false);
            else if (object.activity && object.activity.loader) object.activity.loader(false);

            var voicesContainer = view.find('.shikimori-view__voices');
            voicesContainer.empty();

            if (!translations.length) {
                view.find('.shikimori-view__episodes').html('<div style="color: #e74c3c; padding: 1em;">Видео не найдено.</div>');
                return;
            }

            var prefVoice = Lampa.Storage.get('shikimori_preferred_voice', '');
            if (prefVoice) {
                translations.forEach(function (t, idx) {
                    if (t.title.toLowerCase().indexOf(prefVoice.toLowerCase()) >= 0) {
                        activeTranslation = idx;
                    }
                });
            }

            translations.forEach(function (trans, idx) {
                var btn = $('<div class="shiki-pill selector' + (idx === activeTranslation ? ' active' : '') + '">' + trans.title + ' (' + (trans.quality || '1080p') + ')</div>');
                btn.on('hover:enter', function () {
                    activeTranslation = idx;
                    voicesContainer.find('.shiki-pill').removeClass('active');
                    btn.addClass('active');
                    // Keep the focus on the voice pill the user just pressed:
                    // moving it down to the episode list on every change is what
                    // made the row impossible to browse with the remote.
                    renderSeasons();
                    renderEpisodes({ focus: false });
                });
                voicesContainer.append(btn);
            });

            renderSeasons();
            // Keep the initial focus on the header/poster instead of jumping to
            // the next episode, which scrolled the poster out of view on long
            // series (26+ episodes).
            renderEpisodes({ focus: false });
        }

        function renderEpisodes(options) {
            options = options || {};
            var episodesContainer = view.find('.shikimori-view__episodes');
            var focusedCard = episodesContainer.find('.shiki-ep-card.focus').first();
            var focusedEpisode = focusedCard.length ? focusedCard.attr('data-episode') : null;
            var hadOtherFocus = focusedEpisode === null && scroll.render().find('.selector.focus').length > 0;
            var focusToKeep = document.querySelector('.selector.focus');

            episodesContainer.empty();

            var currentTrans = translations[activeTranslation];
            if (!currentTrans || !currentTrans.seasons) {
                episodesContainer.html('<div>Нет серий в этой озвучке</div>');
                return;
            }

            var seasonObj = currentTrans.seasons[activeSeason] || currentTrans.seasons['1'] || Object.values(currentTrans.seasons)[0];
            if (!seasonObj || !seasonObj.episodes) {
                episodesContainer.html('<div>Нет серий</div>');
                return;
            }

            var episodes = seasonObj.episodes;
            var localWatchedEps = (ShikiApi.getLocalWatchedEpisodes && ShikiApi.getLocalWatchedEpisodes(anime.id)) || [];
            var maxWatched = episodesWatched || 0;
            if (localWatchedEps.length > 0) {
                var maxLocal = Math.max.apply(Math, localWatchedEps);
                maxWatched = Math.max(maxWatched, maxLocal);
            }
            var firstEpNum = episodes.length ? episodes[0].episode : 1;
            var nextEpisodeNum = maxWatched >= firstEpNum ? (maxWatched + 1) : firstEpNum;

            var episodeFragment = document.createDocumentFragment();

            episodes.forEach(function (ep) {
                var isWatched = (ep.episode <= maxWatched && maxWatched >= firstEpNum) || (localWatchedEps.indexOf(ep.episode) !== -1);
                var isNext = (ep.episode === nextEpisodeNum) && !isWatched;

                var epCard = $(`
                    <div class="selector shiki-ep-card" data-episode="${ep.episode}" style="padding: 0.8em; text-align: center; border-radius: 6px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); cursor: pointer;">
                        <div style="font-weight: bold; font-size: 1.1em; margin-bottom: 0.2em;">Серия ${ep.episode}</div>
                        <div class="shiki-ep-status" style="font-size: 0.8em; color: ${isWatched ? '#2ecc71' : (isNext ? '#e74c3c' : '#aaa')};">
                            ${isWatched ? '✓ Просмотрено' : (isNext ? '▶ Смотреть' : 'Не просмотрено')}
                        </div>
                    </div>
                `);

                if (isWatched) epCard.addClass('shiki-ep-watched');
                if (isNext) epCard.addClass('shiki-ep-next');

                epCard.on('hover:enter', function () {
                    playEpisode(ep, currentTrans);
                });

                episodeFragment.appendChild(epCard[0]);
            });

            episodesContainer[0].appendChild(episodeFragment);

            if (window.Lampa && Lampa.Layer) {
                Lampa.Layer.update(scroll.render());
            }

            if (!navigationAllowed(self) || !window.Lampa || !Lampa.Controller) return;

            Lampa.Controller.collectionSet(scroll.render(), false, true);

            if (options.focus === false) {
                // collectionSet() clears the focus class; restore the pill/header
                // the user was on (voice/season change must not drop the highlight).
                if (focusToKeep && document.contains(focusToKeep) && tvCtrl) {
                    tvCtrl.focus(focusToKeep);
                }
                return;
            }

            // Something else on the page is focused (a voice pill, the header):
            // a late async render must not pull the selection away from it.
            if (hadOtherFocus) return;

            // Re-rendering episodes (voice change, progress sync, coming back
            // from the player) used to throw the focus to the next episode. Keep
            // the same episode selected when it still exists.
            var toFocus = null;
            if (focusedEpisode !== null) {
                toFocus = episodesContainer.find('.shiki-ep-card[data-episode="' + focusedEpisode + '"]').first();
            }
            if (!toFocus || !toFocus.length) {
                toFocus = episodesContainer.find('.shiki-ep-next').first();
            }
            if (!toFocus.length) {
                toFocus = episodesContainer.find('.shiki-ep-card').first();
            }
            if (toFocus.length && tvCtrl) {
                tvCtrl.focus(toFocus);
            }
        }

        function playEpisode(ep, translation) {
            Lampa.Noty.show('Запуск ' + (anime.russian || anime.name) + ' — Серия ' + ep.episode + '...', { time: 2000 });

            if (ep.streamUrl && ep.streamUrl.indexOf('.m3u8') >= 0) {
                launchPlayer(ep.streamUrl, ep, translation);
                return;
            }

            KodikBalancer.resolveStream(ep.link, function (res) {
                if (res && res.streamUrl) {
                    launchPlayer(res.streamUrl, ep, translation);
                } else {
                    Lampa.Noty.show('Не удалось получить поток видео', { time: 3000 });
                }
            }, function (err) {
                Lampa.Noty.show('Ошибка: ' + (err || 'не удалось извлечь поток'), { time: 3000 });
            });
        }

        function launchPlayer(streamUrl, ep, translation) {
            var currentSeason = translations[activeTranslation] ? (translations[activeTranslation].seasons[activeSeason] || translations[activeTranslation].seasons['1']) : null;
            var epList = currentSeason ? currentSeason.episodes : [];

            if (window.shikiSendLog) {
                window.shikiSendLog('LAUNCH_PLAYER: animeId=' + anime.id + ' ep=' + ep.episode);
            }

            if (typeof ShikiApi !== 'undefined' && ShikiApi.markLocalEpisodeWatched) {
                ShikiApi.markLocalEpisodeWatched(anime, ep.episode);
            }

            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.send('shikimori_progress_updated', {
                    animeId: anime.id,
                    episode: ep.episode
                });
            }
            setupHeader();
            renderEpisodes();

            syncWatchProgress(ep.episode);

            ShikiPlayer.play({
                anime: anime,
                season: activeSeason,
                episode: ep.episode,
                streamUrl: streamUrl,
                url: streamUrl,
                title: anime.russian || anime.name,
                subtitle: (translation.title || '') + ' • Серия ' + ep.episode,
                voiceTitle: translation.title || '',
                playlist: epList
            });
        }

        function syncWatchProgress(epNum) {
            if (!ShikiApi.isAuthorized() || !anime || !anime.id) return;

            var newStatus = 'watching';
            if (anime.episodes && epNum >= anime.episodes) {
                newStatus = 'completed';
            }

            ShikiApi.updateProgress(anime.id, rateId, epNum, anime.episodes, function (res) {
                if (res && res.id) rateId = res.id;
                if (window.Lampa && Lampa.Noty) {
                    Lampa.Noty.show('Shikimori: отмечена серия ' + epNum + (newStatus === 'completed' ? ' (Просмотрено)' : ' (Смотрю)'), { time: 3000 });
                }
                setupHeader();
            }, function (err) {
                console.warn('Shikimori syncWatchProgress error:', err);
            });
        }
    }

    return {
        init: init,
        createStatusBadge: createStatusBadge
    };
})();
window.ShikiUI = ShikiUI;


/* --- main.js --- */
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


})();
