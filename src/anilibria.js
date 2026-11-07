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
