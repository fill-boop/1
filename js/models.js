// Model registry.
// Each entry points at a public Hugging Face Space. The form for each model is
// built from the Space's own /config at runtime, so new or changed options show
// up automatically. The overrides below only fix things the config can't tell us
// (hidden state inputs, custom components, fields that must match the endpoint).
//
// Fields:
//   id          Space id, "owner/name"
//   name        label shown in the model menu
//   endpoint    api_name of the generate function (or per-task map)
//   tasks       which inputs it supports: "t2v" text, "i2v" image, "v2v" video
//   gpuSize     "xlarge" Spaces use up visitor quota twice as fast
//   backups     other Spaces with the SAME api, tried in order when this one fails
//   hide        input labels to never show (sent with their default value)
//   fixed       input label -> value always sent (not shown)
//   stateFields hidden gr.State inputs that need a real control, by component id
//   choices     label -> choices for custom components the config can't describe
//   rename      label -> nicer label

export const MODELS = [
  {
    key: "ltx23",
    id: "Lightricks/LTX-2-3",
    name: "LTX-2.3 (video + audio)",
    endpoint: "generate_video",
    tasks: ["t2v", "i2v"],
    gpuSize: "large",
    backups: ["linoyts/LTX-2-3"],
  },
  {
    key: "ltx23flf",
    id: "linoyts/LTX-2-3-First-Last-Frame",
    name: "LTX-2.3 First + Last Frame",
    endpoint: "generate_video",
    tasks: ["t2v", "i2v"],
    gpuSize: "large",
    backups: [],
  },
  {
    key: "ltx2turbo",
    id: "alexnasa/ltx-2-TURBO",
    name: "LTX-2 Turbo (camera moves, motion control)",
    endpoint: "generate_video_with_motion_type",
    tasks: ["i2v", "v2v"],
    gpuSize: "xlarge",
    backups: ["rbeard0330/ltx-2-TURBO", "rishi2025/ltx-2-TURBO"],
    stateFields: {
      // generate_video(first, last, prompt, duration <- gr.State, ...)
      29: { label: "Duration (seconds)", type: "slider", minimum: 1, maximum: 10, step: 1, value: 3 },
    },
    // keyed by component id: these are custom HTML radios with no choices in the config
    choices: {
      4: ["Image-to-Video", "Interpolate", "Motion Control", "Video-to-Audio"],
      6: ["Pose", "Canny", "Depth", "Detailer"],
    },
    rename: { 4: "Generation Mode" },
  },
  {
    key: "ltxdistilled",
    id: "Lightricks/ltx-video-distilled",
    name: "LTX-Video Distilled (text / image / video)",
    endpoint: { t2v: "text_to_video", i2v: "image_to_video", v2v: "video_to_video" },
    tasks: ["t2v", "i2v", "v2v"],
    gpuSize: "xlarge",
    backups: [],
    hide: ["image_n", "video_n", "image_i", "video_i", "image_v", "video_v", "task"],
    // the hidden "task" dropdown must match the endpoint
    fixedByTask: {
      t2v: { task: "text-to-video" },
      i2v: { task: "image-to-video" },
      v2v: { task: "video-to-video" },
    },
  },
  {
    key: "wan777",
    id: "kulkas2pintu/wan777",
    name: "Wan 2.2 (most options, first + last frame)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "xlarge",
    backups: ["kulkas2pintu/wan888", "kulkas2pintu/wan666", "kulkas2pintu/wan444", "kulkas2pintu/wan222"],
    hide: ["Display result"],
    fixed: { "Display result": true },
  },
  {
    key: "wanfast",
    id: "KingNish/wan2-2-fast",
    name: "Wan 2.2 Fast (text or image)",
    endpoint: "generate_video",
    tasks: ["t2v", "i2v"],
    gpuSize: "large",
    backups: [],
  },
  {
    key: "wanrcm",
    id: "linoyts/wan2-2-i2v-rCM",
    name: "Wan 2.2 rCM (fast image-to-video)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "large",
    backups: ["zerogpu-aoti/wan2-2-fp8da-aoti-faster"],
  },
  {
    key: "wanaoti",
    id: "zerogpu-aoti/wan2-2-fp8da-aoti-faster",
    name: "Wan 2.2 FP8 AoTI (fast image-to-video)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "large",
    backups: ["linoyts/wan2-2-i2v-rCM"],
  },

  // ---------- added Nov 2026 ----------
  {
    key: "ltx25",
    id: "Lightricks/LTX-2.5",
    name: "LTX-2.5 (text or image)",
    endpoint: "run",
    tasks: ["t2v", "i2v"],
    gpuSize: "xlarge",
  },
  {
    key: "ltx23studio",
    id: "techfreakworm/LTX2.3-Studio",
    name: "LTX-2.3 Studio (camera moves, presets)",
    endpoint: { t2v: "handler", i2v: "handler_1", avatar: "handler_3", v2v: "handler_5" },
    tasks: ["t2v", "i2v", "avatar", "v2v"],
    gpuSize: "large",
  },
  {
    key: "cogvideox",
    id: "zai-org/CogVideoX-5B-Space",
    name: "CogVideoX-5B (text, image or video)",
    endpoint: "generate",
    tasks: ["t2v", "i2v", "v2v"],
    gpuSize: "large",
  },
  {
    key: "t2vturbo",
    id: "TIGER-Lab/T2V-Turbo-V2",
    name: "T2V-Turbo V2 (fast, text only)",
    endpoint: "predict",
    tasks: ["t2v"],
    gpuSize: "large",
    roles: { 0: "prompt" },
    rename: { 0: "Prompt" },
  },
  {
    key: "animatediff",
    id: "ByteDance/AnimateDiff-Lightning",
    name: "AnimateDiff Lightning (short cartoon or realistic clips)",
    endpoint: "generate_image",
    tasks: ["t2v"],
    gpuSize: "large",
  },
  {
    key: "selfforcing",
    id: "multimodalart/self-forcing",
    name: "Self-Forcing (near real-time, experimental)",
    endpoint: "video_generation_handler_streaming",
    tasks: ["t2v"],
    gpuSize: "large",
    streaming: true,
  },
  {
    key: "framepack",
    id: "linoyts/FramePack-F1",
    name: "FramePack F1 (image or text)",
    endpoint: "process",
    tasks: ["i2v", "t2v"],
    gpuSize: "large",
    fixedByTask: { t2v: { "do text-to-video": true }, i2v: { "do text-to-video": false } },
  },
  {
    key: "wan22flf2",
    id: "r3gm/wan2-2-fp8da-aoti-preview",
    name: "Wan 2.2 Preview (first + last frame, many options)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "xlarge",
    hide: ["Display result"],
    fixed: { "Display result": true },
  },
  {
    key: "wan22flf",
    id: "multimodalart/wan-2-2-first-last-frame",
    name: "Wan 2.2 First + Last Frame",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "large",
  },
  {
    key: "wan22lightning",
    id: "Saravutw/WAN2.2_I2V_LIGHTNING_4-8step_custom",
    name: "Wan 2.2 Lightning (4–8 steps)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "xlarge",
    hide: ["Display result"],
    fixed: { "Display result": true },
  },
  {
    key: "wan21fast",
    id: "multimodalart/wan2-1-fast",
    name: "Wan 2.1 Fast (image to video)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "large",
  },
  {
    key: "wan21vace",
    id: "linoyts/wan2-1-VACE-fast",
    name: "Wan 2.1 VACE (from reference images)",
    endpoint: "generate_video",
    tasks: ["i2v"],
    gpuSize: "large",
  },
  {
    key: "hunyuan15",
    id: "multimodalart/Hunyuan-Video-1-5",
    name: "HunyuanVideo 1.5 (image to video)",
    endpoint: "generate",
    tasks: ["i2v"],
    gpuSize: "large",
  },
  {
    key: "animatelcm",
    id: "wangfuyun/AnimateLCM-SVD",
    name: "AnimateLCM SVD (animate a photo, no prompt)",
    endpoint: "video",
    tasks: ["i2v"],
    gpuSize: "large",
    noPrompt: true,
  },
  {
    key: "longcatavatar",
    id: "victor/LongCat-Video-Avatar-1.5",
    name: "LongCat Avatar 1.5 (photo + voice)",
    endpoint: "generate",
    tasks: ["avatar"],
    gpuSize: "xlarge",
  },
  {
    key: "ltx2audio",
    id: "multimodalart/ltx2-audio-to-video",
    name: "LTX-2 Audio to Video (photo + voice)",
    endpoint: "generate",
    tasks: ["avatar"],
    gpuSize: "xlarge",
  },
  {
    key: "wananimate",
    id: "alexnasa/Wan2.2-Animate-ZEROGPU",
    name: "Wan 2.2 Animate (swap or move a character)",
    endpoint: "animate_scene",
    tasks: ["animate"],
    gpuSize: "xlarge",
    noPrompt: true,
    // custom HTML radios, keyed by component id
    choices: { 18: ["Character Swap", "Pose Retarget"], 7: ["Low Res", "Medium Res"] },
    rename: { 18: "Mode", 7: "Resolution", 11: "Driving video", 17: "Character image" },
  },
  {
    key: "liveportrait",
    id: "KlingTeam/LivePortrait",
    name: "LivePortrait (make a face copy a video)",
    endpoint: "gpu_wrapped_execute_video",
    tasks: ["animate"],
    gpuSize: "large",
    noPrompt: true,
    rename: { 12: "Portrait photo", 15: "Driving video (a face talking or moving)" },
  },
  {
    key: "foley",
    id: "tencent/HunyuanVideo-Foley",
    name: "HunyuanVideo Foley (add sound effects)",
    endpoint: "process_inference",
    tasks: ["sound"],
    gpuSize: "large",
    roles: { 9: "prompt" }, // "Audio Description" is the prompt here
  },
];

// The tabs on the page. Each model lists which of these it supports.
export const TASKS = [
  { key: "t2v", label: "Text to video" },
  { key: "i2v", label: "Image to video" },
  { key: "v2v", label: "Video to video" },
  { key: "avatar", label: "Talking avatar" },
  { key: "animate", label: "Animate a character" },
  { key: "sound", label: "Add sound" },
];

// When every copy of a model fails for a non-quota reason, these models are
// offered as the next choice (same kind of input), lightest first.
export const MODEL_FALLBACK_ORDER = {
  t2v: ["ltx23", "wanfast", "ltx25", "ltx23studio", "t2vturbo", "cogvideox", "ltxdistilled", "framepack", "animatediff", "ltx23flf"],
  i2v: ["wanrcm", "wanaoti", "wan21fast", "ltx23", "wanfast", "wan22flf", "hunyuan15", "ltx25", "ltx23studio", "framepack", "wan777", "wan22flf2", "wan22lightning", "cogvideox", "ltx23flf", "ltxdistilled", "ltx2turbo"],
  v2v: ["ltxdistilled", "cogvideox", "ltx23studio", "ltx2turbo"],
  avatar: ["ltx2audio", "longcatavatar", "ltx23studio"],
  animate: ["liveportrait", "wananimate"],
  sound: ["foley"],
};

export function spaceUrl(spaceId) {
  return `https://${spaceId.replace("/", "-").replace(/[._]/g, "-").toLowerCase()}.hf.space`;
}
