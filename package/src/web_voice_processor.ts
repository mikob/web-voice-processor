/*
    Copyright 2018-2021 Picovoice Inc.

    You may not use this file except in compliance with the license. A copy of the license is located in the "LICENSE"
    file accompanying this source.

    Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
    an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
    specific language governing permissions and limitations under the License.
*/

import { DownsamplingWorker, DownsamplingWorkerResponse } from './worker_types';
import DownsamplerWorkerFactory from './downsampler_worker_factory';

export type WebVoiceProcessorOptions = {
  /** Engines to feed downsampled audio to */
  engines?: Array<Worker>;
  /** Immediately start the microphone? */
  start?: boolean;
  /** Size of pcm frames (default: 512) */
  frameLength?: number;
  /** Which sample rate to convert to (default: 16000) */
  outputSampleRate?: number;
  /** Microphone id to use (can be fetched with mediaDevices.enumerateDevices) */
  deviceId?: string | null;
};

/**
 * Obtain microphone permission and audio stream;
 * Downsample audio into 16kHz single-channel PCM for speech recognition (via DownsamplingWorker).
 * Continuously send audio frames to voice processing engines.
 */
export class WebVoiceProcessor {
  private _audioContext: AudioContext;
  private _audioSource: MediaStreamAudioSourceNode;
  private _mediaStream: MediaStream;
  private _downsamplingWorker: DownsamplingWorker;
  private _engines: Array<Worker>;
  private _isRecording: boolean;
  private _isReleased = false;
  private _audioDumpPromise: Promise<Blob> | null = null;
  private _audioDumpResolve: any = null;
  private _audioDumpReject: any = null;

  /**
   * Acquires the microphone audio stream (incl. asking permission),
   * and continuously forwards the downsampled audio to speech recognition worker engines.
   *
   * @param options Startup options including whether to immediately begin
   * processing, and the set of voice processing engines
   * @return the promise from mediaDevices.getUserMedia()
   */

  public static async init(
    options: WebVoiceProcessorOptions,
  ): Promise<WebVoiceProcessor> {
    // Get microphone access and ask user permission
    const microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
      },
    });

    const audioContext = new (window.AudioContext ||
      // @ts-ignore window.webkitAudioContext
      window.webkitAudioContext)();
    const audioSource = audioContext.createMediaStreamSource(microphoneStream);

    const downsamplingWorker = await DownsamplerWorkerFactory.create(
      audioSource.context.sampleRate,
      options.outputSampleRate,
      options.frameLength,
    );

    return new WebVoiceProcessor(
      microphoneStream,
      audioContext,
      audioSource,
      downsamplingWorker,
      options,
    );
  }

  private constructor(
    inputMediaStream: MediaStream,
    audioContext: AudioContext,
    audioSource: MediaStreamAudioSourceNode,
    downsamplingWorker: DownsamplingWorker,
    options: WebVoiceProcessorOptions,
  ) {
    this._mediaStream = inputMediaStream;

    if (options.engines === undefined) {
      this._engines = [];
    } else {
      this._engines = options.engines;
    }
    this._isRecording = options.start ?? true;

    this._downsamplingWorker = downsamplingWorker;
    this._audioContext = audioContext;
    this._audioSource = audioSource;

    const node = audioContext.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event: AudioProcessingEvent): void => {
      if (!this._isRecording) {
        return;
      }

      downsamplingWorker.postMessage({
        command: 'process',
        inputFrame: event.inputBuffer.getChannelData(0),
      });
    };

    this._audioSource.connect(node);
    node.connect(this._audioContext.destination);

    downsamplingWorker.onmessage = (
      event: MessageEvent<DownsamplingWorkerResponse>,
    ): void => {
      switch (event.data.command) {
        case 'output': {
          for (const engine of this._engines) {
            engine.postMessage({
              command: 'process',
              inputFrame: event.data.outputFrame,
            });
          }
          break;
        }
        case 'audio_dump_complete': {
          this._audioDumpResolve(event.data.blob);
          this._audioDumpPromise = null;
          this._audioDumpResolve = null;
          this._audioDumpReject = null;
          break;
        }
        default: {
          console.warn(`Received unexpected command: ${event.data.command}`);
          break;
        }
      }
    };
  }

  /**
   * Record some sample raw signed 16-bit PCM data for some duration, then pack it as a Blob.
   *
   * @param durationMs the duration of the recording, in milliseconds
   * @return the data in Blob format, wrapped in a promise
   */

  public async audioDump(durationMs: number = 3000): Promise<Blob> {
    if (this._audioDumpPromise !== null) {
      return Promise.reject('Audio dump already in progress');
    }

    this._downsamplingWorker.postMessage({
      command: 'start_audio_dump',
      durationMs: durationMs,
    });

    this._audioDumpPromise = new Promise<Blob>((resolve, reject) => {
      this._audioDumpResolve = resolve;
      this._audioDumpReject = reject;
    });

    return this._audioDumpPromise;
  }

  /**
   * Stop listening to the microphone & release all resources; terminate downsampling worker.
   *
   * @return the promise from AudioContext.close()
   */

  public async release(): Promise<void> {
    if (!this._isReleased) {
      this._isReleased = true;
      this._isRecording = false;
      this._downsamplingWorker.postMessage({ command: 'reset' });
      this._downsamplingWorker.terminate();

      for (const track of this._mediaStream.getTracks()) {
        track.stop();
      }

      await this._audioContext.close();
    }
  }

  public start(): void {
    this._isRecording = true;
  }

  public pause(): void {
    this._isRecording = false;
  }

  public resume(): void {
    this._isRecording = true;
  }

  get audioContext(): AudioContext {
    return this._audioContext;
  }

  get audioSource(): MediaStreamAudioSourceNode {
    return this._audioSource;
  }

  get mediaStream(): MediaStream {
    return this._mediaStream;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  get isReleased(): boolean {
    return this._isReleased;
  }
}
