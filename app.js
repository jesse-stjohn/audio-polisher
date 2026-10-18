const videoFile = document.getElementById('videoFile');
const polishBtn = document.getElementById('polishBtn');
const status = document.getElementById('status');
const originalVideo = document.getElementById('originalVideo');
const polishedAudio = document.getElementById('polishedAudio');
const downloadLink = document.getElementById('downloadLink');

let ffmpeg = null;

function measureAudio(audioBuffer) {
    let peak = 0;
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) {
            const value = Math.abs(data[i]);
            if (value > peak) peak = value;
            sum += data[i] * data[i];
            count++;
        }
    }
    return { peak: peak, average: Math.sqrt(sum / count) };
}

async function compressAudio(audioBuffer) {
    const offlineContext = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;

    const compressor = offlineContext.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    source.connect(compressor);
    compressor.connect(offlineContext.destination);
    source.start();

    return offlineContext.startRendering();
}

async function trimPeak(audioBuffer) {
    const measured = measureAudio(audioBuffer);
    if (measured.peak <= 0.89) return audioBuffer;

    const gainValue = 0.89 / measured.peak;

    const offlineContext = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    const gainNode = offlineContext.createGain();
    gainNode.gain.value = gainValue;
    source.connect(gainNode);
    gainNode.connect(offlineContext.destination);
    source.start();

    return offlineContext.startRendering();
}

async function levelAudio(audioBuffer) {
    const windowSize = Math.floor(audioBuffer.sampleRate * 0.4);
    const numberOfWindows = Math.ceil(audioBuffer.length / windowSize);
    const target = 0.18;
    const gains = [];
    let lastGain = 1;

    for (let w = 0; w < numberOfWindows; w++) {
        let sum = 0;
        let count = 0;
        const start = w * windowSize;
        const end = Math.min(start + windowSize, audioBuffer.length);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            const data = audioBuffer.getChannelData(channel);
            for (let i = start; i < end; i += 10) {
                sum += data[i] * data[i];
                count++;
            }
        }
        const rms = Math.sqrt(sum / count);

        let gain;
        if (rms < 0.02) {
            gain = lastGain;
        } else {
            gain = target / rms;
            if (gain > 2.5) gain = 2.5;
            if (gain < 0.5) gain = 0.5;
        }
        gains.push(gain);
        lastGain = gain;
    }

    const smoothed = gains.map((g, i) => {
        const prev = gains[Math.max(0, i - 1)];
        const next = gains[Math.min(gains.length - 1, i + 1)];
        return (prev + g + next) / 3;
    });

    const offlineContext = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    const gainNode = offlineContext.createGain();
    gainNode.gain.setValueCurveAtTime(new Float32Array(smoothed), 0, audioBuffer.duration);
    source.connect(gainNode);
    gainNode.connect(offlineContext.destination);
    source.start();

    return offlineContext.startRendering();
}

async function polishTone(audioBuffer) {
    const offlineContext = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;

    const rumbleCut = offlineContext.createBiquadFilter();
    rumbleCut.type = 'highpass';
    rumbleCut.frequency.value = 80;

    const clarity = offlineContext.createBiquadFilter();
    clarity.type = 'peaking';
    clarity.frequency.value = 3000;
    clarity.Q.value = 1;
    clarity.gain.value = 3;

    source.connect(rumbleCut);
    rumbleCut.connect(clarity);
    clarity.connect(offlineContext.destination);
    source.start();

    return offlineContext.startRendering();
}

function audioBufferToWav(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numberOfChannels * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);

    function writeString(offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, length - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * 2, true);
    view.setUint16(32, numberOfChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length - 44, true);

    const channels = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
        channels.push(audioBuffer.getChannelData(channel));
    }

    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const sample = Math.max(-1, Math.min(1, channels[channel][i]));
            view.setInt16(offset, sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return new Blob([view], { type: 'audio/wav' });
}

videoFile.addEventListener('change', () => {
    const file = videoFile.files[0];

    if (!file) {
        status.textContent = 'No video selected yet.';
        polishBtn.disabled = true;
        originalVideo.hidden = true;
        return;
    }

    status.textContent = 'Selected: ' + file.name;
    polishBtn.disabled = false;
    originalVideo.src = URL.createObjectURL(file);
    originalVideo.hidden = false;
});

polishBtn.addEventListener('click', async () => {
    const file = videoFile.files[0];
    if (!file) return;

    status.textContent = 'Reading audio...';
    let stage = 'reading the audio';

    try {
        stage = 'loading the audio tool';
        status.textContent = 'Loading the audio tool...';

        if (!ffmpeg) {
            ffmpeg = FFmpeg.createFFmpeg({ log: false, mainName: 'main', corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js' });
        }

        if (!ffmpeg.isLoaded()) await ffmpeg.load();

        stage = 'pulling the audio out';
        status.textContent = 'Pulling the audio out...';

        ffmpeg.FS('writeFile', 'input.mp4', await FFmpeg.fetchFile(file));
        await ffmpeg.run('-i', 'input.mp4', '-vn', 'audio.wav');
        const wavData = ffmpeg.FS('readFile', 'audio.wav');

        stage = 'reading the audio';
        status.textContent = 'Reading audio...';

        const audioContext = new AudioContext();
        const audioBuffer = await audioContext.decodeAudioData(wavData.buffer);
        await audioContext.close();


        const before = measureAudio(audioBuffer);

        stage = 'leveling the volume';
        const leveledBuffer = await levelAudio(audioBuffer);

        stage = 'polishing the tone';
        const tonedBuffer = await polishTone(leveledBuffer);

        stage = 'compressing the audio';
        const compressedBuffer = await compressAudio(tonedBuffer);

        stage = 'trimming the peak';
        const polishedBuffer = await trimPeak(compressedBuffer);
        const after = measureAudio(polishedBuffer);

        status.textContent = 'Done. Peak was ' + before.peak.toFixed(2) + ', now ' + after.peak.toFixed(2) + '. Average was ' + before.average.toFixed(2) + ', now ' + after.average.toFixed(2) + '.';
        const wavBlob = audioBufferToWav(polishedBuffer);
        polishedAudio.src = URL.createObjectURL(wavBlob);
        polishedAudio.hidden = false;

        stage = 'building the finished video';
        const builder = FFmpeg.createFFmpeg({ log: false, mainName: 'main', corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js' });
        await builder.load();
        builder.FS('writeFile', 'input.mp4', await FFmpeg.fetchFile(file));
        const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
        builder.FS('writeFile', 'polished.wav', wavBytes);
        await builder.run('-i', 'input.mp4', '-i', 'polished.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'output.mp4');
        const outputData = builder.FS('readFile', 'output.mp4');

        const outputBlob = new Blob([outputData.buffer], { type: 'video/mp4' });
        downloadLink.href = URL.createObjectURL(outputBlob);
        downloadLink.download = 'polished-video.mp4';
        downloadLink.hidden = false;
        status.textContent = status.textContent + ' Finished video ready below.';

    } catch (error) {
        const message = error.message ? error.message : error.name;
        status.textContent = 'Failed while ' + stage + ': ' + message;
    }
});