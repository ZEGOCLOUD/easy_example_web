import { ZegoExpressEngine } from "zego-express-engine-webrtc";
import {
  ZegoCapabilityDetection,
  ZegoPlayStats,
  ZegoPublishStats,
  ZegoStreamList,
} from "zego-express-engine-webrtc/sdk/code/zh/ZegoExpressEntity.web";
import {
  ZegoDeviceUpdateType,
  ZegoMediaOptions,
  ZegoParticipant,
  ZegoRoomConfig,
  ZegoUser,
} from "./ZegoExpressManager.entity";

export class ZegoExpressManager {
  // key is UserID, value is participant model
  private participantDic: Map<string, ZegoParticipant> = new Map();
  // key is streamID, value is participant model
  private streamDic: Map<string, ZegoParticipant> = new Map();
  private localParticipant!: ZegoParticipant;
  private roomID = "";
  private streamMap: Map<string, MediaStream> = new Map();
  private mediaOptions: ZegoMediaOptions[] = [
    ZegoMediaOptions.AutoPlayAudio,
    ZegoMediaOptions.AutoPlayVideo,
    ZegoMediaOptions.PublishLocalAudio,
    ZegoMediaOptions.PublishLocalVideo,
  ];
  private deviceUpdateCallback: ((
    updateType: ZegoDeviceUpdateType,
    userID: string,
    roomID: string
  ) => void)[] = [];
  static shared: ZegoExpressManager = new ZegoExpressManager();
  static engine: ZegoExpressEngine;
  private constructor() {
    if (!ZegoExpressManager.shared) {
      this.localParticipant = {} as ZegoParticipant;
      ZegoExpressManager.shared = this;
    }
    return ZegoExpressManager.shared;
  }
  static getEngine() {
    return ZegoExpressManager.engine;
  }
  createEngine(appID: number, server: string) {
    if (!ZegoExpressManager.engine) {
      ZegoExpressManager.engine = new ZegoExpressEngine(appID, server);
      this.onOtherEvent();
    }
  }
  checkWebRTC(): Promise<boolean> {
    return ZegoExpressManager.engine
      .checkSystemRequirements("webRTC")
      .then((result: ZegoCapabilityDetection) => {
        return !!result.webRTC;
      });
  }
  checkCamera(): Promise<boolean> {
    return ZegoExpressManager.engine
      .checkSystemRequirements("camera")
      .then((result: ZegoCapabilityDetection) => {
        return !!result.camera;
      });
  }
  checkMicrophone(): Promise<boolean> {
    return ZegoExpressManager.engine
      .checkSystemRequirements("microphone")
      .then((result: ZegoCapabilityDetection) => {
        return !!result.microphone;
      });
  }
  joinRoom(
    roomID: string,
    token: string,
    user: ZegoUser,
    options?: ZegoMediaOptions[]
  ): Promise<boolean> {
    if (!token) {
      console.error(
        "Error: [joinRoom] token is empty, please enter a right token"
      );
      return Promise.resolve(false);
    }
    this.roomID = roomID;
    options && (this.mediaOptions = options);

    this.localParticipant.userID = user.userID;
    this.localParticipant.name = user.userName;
    this.localParticipant.streamID = this.generateStreamID(user.userID, roomID);

    this.participantDic.set(
      this.localParticipant.userID,
      this.localParticipant
    );
    this.streamDic.set(this.localParticipant.streamID, this.localParticipant);

    const config: ZegoRoomConfig = {
      userUpdate: true,
      maxMemberCount: 0,
    };
    return ZegoExpressManager.engine
      .loginRoom(roomID, token, user, config)
      .then(async (result) => {
        if (result) {
          this.localParticipant.camera = this.mediaOptions.includes(
            ZegoMediaOptions.PublishLocalVideo
          );
          this.localParticipant.mic = this.mediaOptions.includes(
            ZegoMediaOptions.PublishLocalAudio
          );
          if (this.localParticipant.camera || this.localParticipant.mic) {
            const source = {
              camera: {
                audio: this.localParticipant.mic,
                video: this.localParticipant.camera,
                facingMode: "user" as "user" | "environment",
              },
            };
            const localStream = await ZegoExpressManager.engine.createStream(
              source
            );
            this.streamMap.set(this.localParticipant.streamID, localStream);
            await ZegoExpressManager.engine.startPublishingStream(
              this.localParticipant.streamID,
              localStream
            );
          }
        }
        return result;
      });
  }
  enableCamera(enable: boolean): boolean {
    const streamID = this.localParticipant.streamID;
    const streamObj = this.streamMap.get(streamID) as MediaStream;
    const result = ZegoExpressManager.engine.mutePublishStreamVideo(
      streamObj,
      !enable
    );

    result && (this.localParticipant.camera = enable);
    return result;
  }
  enableMic(enable: boolean): boolean {
    const streamID = this.localParticipant.streamID;
    const streamObj = this.streamMap.get(streamID) as MediaStream;
    const result = ZegoExpressManager.engine.mutePublishStreamAudio(
      streamObj,
      !enable
    );
    result && (this.localParticipant.mic = enable);
    return result;
  }
  setLocalVideoView(renderView: HTMLMediaElement) {
    if (!this.roomID) {
      console.error(
        "Error: [setVideoView] You need to join the room first and then set the videoView"
      );
    }
    const { streamID, userID } = this.localParticipant;
    const streamObj = this.streamMap.get(streamID) as MediaStream;
    renderView.srcObject = streamObj;
    this.localParticipant.renderView = renderView;
    this.participantDic.set(userID, this.localParticipant);
    this.streamDic.set(streamID, this.localParticipant);
  }
  setRemoteVideoView(userID: string, renderView: HTMLMediaElement) {
    if (!this.roomID) {
      console.error(
        "Error: [setVideoView] You need to join the room first and then set the videoView"
      );
    }
    if (!userID) {
      console.error(
        "Error: [setVideoView] userID is empty, please enter a right userID"
      );
    }
    const participant = this.participantDic.get(userID) as ZegoParticipant;
    participant.renderView = renderView;
    this.participantDic.set(userID, participant);
    if (participant.streamID) {
      // inner roomStreamUpdate -> inner roomUserUpdate -> out roomUserUpdate
      this.streamDic.set(participant.streamID, participant);
    } else {
      // inner roomUserUpdate -> out roomUserUpdate -> inner roomStreamUpdate
    }
    this.renderViewHandle(userID);
  }
  leaveRoom() {
    ZegoExpressManager.engine.stopPublishingStream(
      this.localParticipant.streamID
    );
    this.streamMap.forEach((streamObj, streamID) => {
      ZegoExpressManager.engine.stopPlayingStream(streamID);
      (this.streamDic.get(streamID) as ZegoParticipant).renderView.srcObject =
        null;
    });
    this.participantDic.clear();
    this.streamDic.clear();
    this.streamMap.clear();
    this.roomID = "";
    this.localParticipant.renderView.srcObject = null;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.localParticipant = null;

    return ZegoExpressManager.engine.logoutRoom();
  }
  onRoomUserUpdate(
    fun: (
      roomID: string,
      updateType: "DELETE" | "ADD",
      userList: ZegoUser[]
    ) => void
  ) {
    return ZegoExpressManager.engine.on("roomUserUpdate", fun);
  }
  onRoomUserDeviceUpdate(
    fun: (
      updateType: ZegoDeviceUpdateType,
      userID: string,
      roomID: string
    ) => void
  ) {
    this.deviceUpdateCallback.push(fun);
    return true;
  }
  onRoomTokenWillExpire(fun: (roomID: string) => void) {
    return ZegoExpressManager.engine.on("tokenWillExpire", fun);
  }
  private async playStream(stream: ZegoStreamList) {
    if (
      this.mediaOptions.includes(ZegoMediaOptions.AutoPlayAudio) ||
      this.mediaOptions.includes(ZegoMediaOptions.AutoPlayVideo)
    ) {
      const playOption = {
        audio: this.mediaOptions.includes(ZegoMediaOptions.AutoPlayAudio),
        video: this.mediaOptions.includes(ZegoMediaOptions.AutoPlayVideo),
      };
      const remoteStream = await ZegoExpressManager.engine.startPlayingStream(
        stream.streamID,
        playOption
      );
      this.streamMap.set(stream.streamID, remoteStream);
      this.renderViewHandle(stream.user.userID);
    }
  }
  private generateStreamID(userID: string, roomID: string): string {
    if (!userID) {
      console.error(
        "Error: [generateStreamID] userID is empty, please enter a right userID"
      );
    }
    if (!roomID) {
      console.error(
        "Error: [generateStreamID] roomID is empty, please enter a right roomID"
      );
    }

    // The streamID can use any character.
    // For the convenience of query, roomID + UserID + suffix is used here.
    const streamID = roomID + "_" + userID + "_main_web";
    return streamID;
  }
  private onOtherEvent() {
    ZegoExpressManager.engine.on(
      "roomUserUpdate",
      (roomID: string, updateType: "DELETE" | "ADD", userList: ZegoUser[]) => {
        userList.forEach((user) => {
          if (updateType === "ADD") {
            const participant = this.participantDic.get(user.userID);
            if (participant) {
              // inner roomStreamUpdate -> inner roomUserUpdate -> out roomUserUpdate
            } else {
              // inner roomUserUpdate -> out roomUserUpdate -> inner roomStreamUpdate
              this.participantDic.set(user.userID, {
                userID: user.userID,
                name: user.userName,
              } as ZegoParticipant);
            }
          } else {
            this.participantDic.delete(user.userID);
          }
        });
      }
    );
    ZegoExpressManager.engine.on(
      "roomStreamUpdate",
      (
        roomID: string,
        updateType: "DELETE" | "ADD",
        streamList: ZegoStreamList[]
      ) => {
        streamList.forEach((stream) => {
          const participant = this.participantDic.get(stream.user.userID);
          if (updateType === "ADD") {
            const participant_ = {
              userID: stream.user.userID,
              name: stream.user.userName,
              streamID: stream.streamID,
            };
            if (participant) {
              // inner roomUserUpdate -> out roomUserUpdate -> inner roomStreamUpdate
              participant.streamID = stream.streamID;
              this.participantDic.set(stream.user.userID, participant);
              this.streamDic.set(stream.streamID, participant);
            } else {
              // inner roomStreamUpdate -> inner roomUserUpdate -> out roomUserUpdate
              this.participantDic.set(
                stream.user.userID,
                participant_ as ZegoParticipant
              );
              this.streamDic.set(
                stream.streamID,
                participant_ as ZegoParticipant
              );
            }
            this.playStream(stream);
          } else {
            ZegoExpressManager.engine.stopPlayingStream(stream.streamID);
            this.streamMap.delete(stream.streamID);
            this.streamDic.delete(stream.streamID);
            (participant as ZegoParticipant).renderView.srcObject = null;
          }
        });
      }
    );
    ZegoExpressManager.engine.on(
      "publishQualityUpdate",
      (streamID: string, stats: ZegoPublishStats) => {
        // console.error("inner publishQualityUpdate");
        const participant = this.streamDic.get(streamID);
        if (!participant) return;

        participant.publishAudioQuality = stats.audio.audioQuality;
        participant.publishVideoQuality = stats.video.videoQuality;

        this.streamDic.set(streamID, participant);
        this.participantDic.set(participant.userID, participant);
      }
    );
    ZegoExpressManager.engine.on(
      "playQualityUpdate",
      (streamID: string, stats: ZegoPlayStats) => {
        // console.error("inner playQualityUpdate");
        const participant = this.streamDic.get(streamID);
        if (!participant) return;

        participant.playAudioQuality = stats.audio.audioQuality;
        participant.playVideoQuality = stats.video.videoQuality;

        this.streamDic.set(streamID, participant);
        this.participantDic.set(participant.userID, participant);
      }
    );
    ZegoExpressManager.engine.on(
      "remoteCameraStatusUpdate",
      (streamID: string, status: "OPEN" | "MUTE") => {
        const participant = this.streamDic.get(streamID);
        if (participant) {
          const updateType =
            status === "OPEN"
              ? ZegoDeviceUpdateType.CameraOpen
              : ZegoDeviceUpdateType.CameraClose;
          participant.camera = status === "OPEN";
          this.streamDic.set(streamID, participant);
          this.participantDic.set(participant.userID, participant);
          this.deviceUpdateCallback.forEach((fun) => {
            fun(updateType, participant.userID, this.roomID);
          });
        }
      }
    );
    ZegoExpressManager.engine.on(
      "remoteMicStatusUpdate",
      (streamID: string, status: "OPEN" | "MUTE") => {
        const participant = this.streamDic.get(streamID);
        if (participant) {
          const updateType =
            status === "OPEN"
              ? ZegoDeviceUpdateType.MicUnmute
              : ZegoDeviceUpdateType.MicMute;
          participant.mic = status === "OPEN";
          this.streamDic.set(streamID, participant);
          this.participantDic.set(participant.userID, participant);
          this.deviceUpdateCallback.forEach((fun) => {
            fun(updateType, participant.userID, this.roomID);
          });
        }
      }
    );
  }
  private renderViewHandle(userID: string) {
    const participant = this.participantDic.get(userID);
    if (participant && participant.streamID && participant.renderView) {
      const streamObj = this.streamMap.get(participant.streamID);
      participant.renderView.srcObject = streamObj as MediaStream;
    }
  }
}