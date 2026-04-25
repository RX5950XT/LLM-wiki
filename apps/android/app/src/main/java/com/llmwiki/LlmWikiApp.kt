package com.llmwiki

import android.app.Application
import com.llmwiki.data.SupabaseClientProvider

class LlmWikiApp : Application() {

    override fun onCreate() {
        super.onCreate()
        SupabaseClientProvider.init(
            url = BuildConfig.SUPABASE_URL,
            anonKey = BuildConfig.SUPABASE_ANON_KEY,
        )
    }
}
