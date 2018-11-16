'use-strict'
$(()=>{
    const bundleName = 'nodecg-speedcontrol';
    // keeps track of which channel has sound, cause only one at a time can have sound, -1 is all muted
    var soundOnTwitchStream = nodecg.Replicant('sound-on-twitch-stream', bundleName, {'persistent':false,'defaultValue':-1});
    // main control panel for streams
    var streams = nodecg.Replicant('twitch-streams', bundleName);

    // handle muting/unmuting
    $('.stream-mute').click((elem)=> {
        // find out which stream was meant to be muted/unmuted
        const streamID = elem.target.parentElement.id;
        const streamNr = parseInt(streamID[streamID.length - 1]);
        if (soundOnTwitchStream.value == streamNr) {
            soundOnTwitchStream.value = -1;
        } else {
            soundOnTwitchStream.value = streamNr;
        }
    });

    soundOnTwitchStream.on('change', (newValue, old)=> {
        for (var i = 0;i < 4;i++) {
            $('#stream-control'+i).find('.stream-mute').text(i==newValue ? 'Mute':'Unmute');
        }
    });

    // handle refresh
    $('.stream-refresh').click((elem)=> {
        // find out which stream was meant to be refreshed
        const streamID = elem.target.parentElement.id;
        const streamNr = parseInt(streamID[streamID.length - 1]);
        nodecg.log.info('refreshing stream '+streamNr);
        nodecg.sendMessage('refreshStream',(streamNr));
    });

    // handle play/pause
    $('.stream-pause').click((elem)=> {
        // find out which stream was meant to be refreshed
        const streamID = elem.target.parentElement.id;
        const streamNr = parseInt(streamID[streamID.length - 1]);
        if (streams.value[streamNr].paused) {
            nodecg.log.info('started stream '+streamNr);
            streams.value[streamNr].paused = false;
        } else {
            nodecg.log.info('stopped stream '+streamNr);
            streams.value[streamNr].paused = true;
        }
    });

    // handle external changes
    streams.on('change', (newStreams, old) => {
        for (var i in newStreams) {
            const stream = newStreams[i];
            const controlContainer = $('#stream-control'+i);
            // update pause/play text
            controlContainer.find('.stream-pause').text(stream.paused?'Play':'Pause');
            // set volume slider to right value
            controlContainer.find('.stream-volume').val(stream.volume * 100);
        }
    });

    $('.stream-volume').on('input', (elem) => {
        const streamID = elem.target.parentElement.parentElement.id;
        const streamNr = parseInt(streamID[streamID.length - 1]);
        streams.value[streamNr].volume = parseInt(elem.target.value)/100;
    });
});