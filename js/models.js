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
];

// When every copy of a model fails for a non-quota reason, these models are
// offered as the next choice (same kind of input).
export const MODEL_FALLBACK_ORDER = {
  t2v: ["ltx23", "wanfast", "ltxdistilled", "ltx23flf"],
  i2v: ["wanrcm", "wanaoti", "ltx23", "wanfast", "wan777", "ltx23flf", "ltxdistilled", "ltx2turbo"],
  v2v: ["ltxdistilled", "ltx2turbo"],
};

export function spaceUrl(spaceId) {
  return `https://${spaceId.replace("/", "-").replace(/[._]/g, "-").toLowerCase()}.hf.space`;
}
