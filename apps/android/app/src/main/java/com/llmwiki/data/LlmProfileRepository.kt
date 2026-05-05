package com.llmwiki.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order

class ProfileAuthRequiredException : IllegalStateException("Profile sync requires a valid session")

class LlmProfileRepository(
    private val supabase: SupabaseClient,
) {
    suspend fun listProfiles(): List<LlmProfile> {
        supabase.auth.awaitInitialization()
        val accessToken = supabase.requireAccessToken(forceRefresh = true)
        val userId = supabase.auth.currentSessionOrNull()?.user?.id
        if (accessToken.isNullOrBlank() || userId.isNullOrBlank()) {
            throw ProfileAuthRequiredException()
        }

        return supabase.from("llm_profiles")
            .select(columns = Columns.raw("id,name,base_url,model,is_default,created_at")) {
                filter { eq("owner_id", userId) }
                order("created_at", order = Order.ASCENDING)
            }
            .decodeList()
    }
}
