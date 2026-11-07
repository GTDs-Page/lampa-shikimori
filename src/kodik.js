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
