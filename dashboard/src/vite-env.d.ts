/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_VAPI_PUBLIC_KEY?: string;
  readonly VITE_ASSISTANT_CORE_ID?: string;
  readonly VITE_ASSISTANT_SOLO_ID?: string;
  readonly VITE_SQUAD_ID?: string;
  readonly VITE_BUILD_SHA?: string;
  readonly VITE_PHONE_NUMBER?: string;
  readonly VITE_GHL_LOCATION_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
