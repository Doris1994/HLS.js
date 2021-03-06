/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Video Helper Functions */

function parseNALStream(bytes){
	'use strict';
	var view = new DataView(bytes.buffer,bytes.byteOffset),
		len = bytes.byteLength - 3,
		start, end = 1, nalUnits = [];

	do {
		// Check # of sync bytes (0x000001 or 0x00000001)
		end += view.getUint16(end+1)?3:4;
		for(start = end; end < len; end++){
			// Step forward until we hit another 3- or 4-byte header
			if(view.getUint16(end) === 0 &&
				(bytes[end+2] === 1 || (view.getUint16(end+2) === 1))){
				nalUnits.push(bytes.subarray(start, end));
				break;
			}
		}
	}while(end < len);
	// A packet can't end with a header,
	// so one last NAL Unit extends to the end
	nalUnits.push(bytes.subarray(start));
	return nalUnits;
}

// Merge NAL Units from all packets into a single
// continuous buffer, separated by 4-byte length headers
function mergeNALUs(nalus,length){
	'use strict';
	var arr = new Uint8Array(length),
		view = new DataView(arr.buffer),
		unit, offset, i;
	for(i = 0, offset = 0; offset < length; i++){
		unit = nalus[i];
		view.setUint32(offset, unit.byteLength);
		arr.set(unit, offset+4);
		offset += unit.byteLength + 4;
	}
	return arr;
}

function video_data(stream){
	'use strict';
	var packets = stream.packets,
		pps, sps, spsInfo, cropping,
		dts_delta, size, isIDR,
		samples = [], nalus = [],
		dts_deltas = [],
		packet = packets[0], offset = 0,
		duration = 0, zeroes = 0,
		frame_sum = 0, frame_count = 0,
		frame_rate, next, len, i;

	for(i = 1, len = packets.length; i <= len; i++){
		next = packets[i] || {offset: offset, dts: packet.dts};
		size = 0;
		isIDR = false;

		parseNALStream(packet.data).forEach(function(nalUnit){
			switch(nalUnit[0] & 0x1F){
				case 7:
					sps = nalUnit;
					break;
				case 8:
					pps = nalUnit;
					break;
				case 5:
					isIDR = true;
				default: /* falls through */
					size += nalUnit.length+4;
					nalus.push(nalUnit);
			}
		});

		dts_delta = next.dts - packet.dts;
		samples.push({
			offset: offset,
			size: size,
			pts: packet.pts,
			dts: packet.dts,
			cts: packet.pts - packet.dts,
			duration: dts_delta,
			isIDR: isIDR
		});

		if(dts_delta){
			duration += dts_delta;
			frame_sum += dts_delta;
			frame_count++;
		}else{
			zeroes++;
		}

		offset += size;
		packet = next;
	}

	frame_rate = Math.round(frame_sum / frame_count);
	duration += zeroes * frame_rate;
	spsInfo = parseSPS(sps);
	cropping = spsInfo.frame_cropping;

	return {
		type: 'video',
		pps: pps, sps: sps,
		spsInfo: spsInfo,
		width: (spsInfo.pic_width_in_mbs * 16)
				- (cropping.left + cropping.right) * 2,
		height: (2 - spsInfo.frame_mbs_only_flag) * (spsInfo.pic_height_in_map_units * 16)
				- (cropping.top + cropping.bottom) * 2,
		samples: samples,
		duration: duration,
		data: mergeNALUs(nalus, offset)
	};
}

var sampleRates = [
	96000, 88200, 64000, 48000, 44100, 32000,
	24000, 22050, 16000, 12000, 11025, 8000, 7350
];

function audio_data(stream){
	'use strict';
	var audioSize = stream.byteLength,
		audioBuffer = new Uint8Array(audioSize),
		audioView = new DataView(audioBuffer.buffer),
		samples = [], maxAudioSize = 0, woffset = 0, roffset = 0,
		data_length, packet_length, header_length, 
		duration, header, frames, freqIndex;

	// Copy PES payloads into a single continuous buffer
	// This accounts for more than one ADTS packet per PES packet,
	// as well as the possibility of ADTS packets split across PES packets
	stream.packets.forEach(function(packet){
		audioBuffer.set(packet.data, woffset);
		woffset += packet.data.byteLength;
	});

	// Save 2 bytes of the first header to extract metadata
	header = audioView.getUint32(2);

	// Shift ADTS payloads in the buffer to eliminate intervening headers
	for(woffset = 0; roffset < audioSize;){
		header_length = (audioView.getUint8(roffset+1)&1) ? 7 : 9;
		packet_length = (audioView.getUint32(roffset+2)>>5)&0x1fff;
		data_length = packet_length - header_length;

		// Empirically, there's always 1 AAC/ADTS frame,
		// and frequency is constant per stream segment
		//console.log("AAC frames per ADTS frame:", (audioView.getUint8(roffset+6) & 3) + 1);
		//console.log("Sampling Frequency:", (audioView.getUint8(roffset+2) >> 2) & 0xf);

		audioBuffer.set(
			audioBuffer.subarray(
				roffset+header_length,
				roffset+packet_length
			), woffset
		);

		roffset += packet_length;
		woffset += data_length;
		samples.push({size: data_length});
		if(maxAudioSize < data_length){
			maxAudioSize = data_length;
		}
	}

	frames = samples.length;
	freqIndex = (header >> 26) & 0xf;
	duration = frames * 1024 / sampleRates[freqIndex];

	return {
		type: 'audio',
		profileMinusOne: (header >>> 30),
		channelConfig: (header >> 22) & 0x7,
		samplingFreqIndex: freqIndex,
		maxAudioSize: maxAudioSize,
		maxBitrate: Math.round(maxAudioSize / (duration / frames)),
		avgBitrate: Math.round(woffset / duration),
		samples: samples,
		duration: Math.round(90000 * duration),
		data: audioBuffer.subarray(0,woffset)
	};

}

addEventListener('message', function(event){
	var file, msg = event.data,
		streams = msg.streams,
		tracks = [];

	if(streams[0xE0]){ tracks.push(video_data(streams[0xE0])); }
	if(streams[0xC0]){ tracks.push(audio_data(streams[0xC0])); }

	file = MP4.File(tracks);
	postMessage({
		index: msg.index,
		file: file.buffer
	},[file.buffer]);
});
