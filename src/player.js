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
