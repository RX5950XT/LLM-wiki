package com.llmwiki.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.SettingsCodeVerifierCache
import io.github.jan.supabase.auth.SettingsSessionManager
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.realtime.Realtime

object SupabaseClientProvider {

    lateinit var client: SupabaseClient
        private set

    fun init(url: String, anonKey: String) {
        client = createSupabaseClient(
            supabaseUrl = url,
            supabaseKey = anonKey,
        ) {
            install(Auth) {
                alwaysAutoRefresh = true
                autoLoadFromStorage = true
                autoSaveToStorage = true
                sessionManager = SettingsSessionManager()
                codeVerifierCache = SettingsCodeVerifierCache()
            }
            install(Postgrest)
            install(Realtime)
        }
    }
}
