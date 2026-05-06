package com.llmwiki

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.llmwiki.data.AppPreferencesRepository
import com.llmwiki.data.ThemeMode
import kotlinx.coroutines.runBlocking
import com.llmwiki.ui.LlmWikiNavGraph
import com.llmwiki.ui.theme.LlmWikiTheme

data class ExternalEvent(
    val value: String,
    val token: Long = System.nanoTime(),
)

class MainActivity : AppCompatActivity() {

    private var shareUrlEvent by mutableStateOf<ExternalEvent?>(null)
    private var authReturnEvent by mutableStateOf<ExternalEvent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        val preferencesRepository = AppPreferencesRepository(applicationContext)
        val initialLanguage = runBlocking { preferencesRepository.getLanguage() }
        val currentLocales = AppCompatDelegate.getApplicationLocales().toLanguageTags()
        val targetLocales = initialLanguage.toLocaleList().toLanguageTags()
        if (currentLocales != targetLocales) {
            AppCompatDelegate.setApplicationLocales(initialLanguage.toLocaleList())
        }

        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        shareUrlEvent = extractSharedUrl(intent)?.let(::ExternalEvent)
        authReturnEvent = extractAuthReturn(intent)?.let(::ExternalEvent)

        setContent {
            val rememberedPreferencesRepository = remember { preferencesRepository }
            val themeMode by rememberedPreferencesRepository.themeMode.collectAsState(initial = ThemeMode.SYSTEM)
            val language by rememberedPreferencesRepository.language.collectAsState(initial = initialLanguage)

            LaunchedEffect(language) {
                val desiredLocales = language.toLocaleList()
                if (AppCompatDelegate.getApplicationLocales().toLanguageTags() != desiredLocales.toLanguageTags()) {
                    AppCompatDelegate.setApplicationLocales(desiredLocales)
                }
            }

            LlmWikiTheme(themeMode = themeMode) {
                LlmWikiNavGraph(
                    shareUrlEvent = shareUrlEvent,
                    authReturnEvent = authReturnEvent,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        extractSharedUrl(intent)?.let { shareUrlEvent = ExternalEvent(it) }
        extractAuthReturn(intent)?.let { authReturnEvent = ExternalEvent(it) }
    }

    /** Extracts a URL from an incoming ACTION_SEND text/plain intent. */
    private fun extractSharedUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        if (intent.type != "text/plain") return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
        // Take the first token that looks like a URL; Chrome sends "Title\nURL" or just "URL"
        return text.lines()
            .map { it.trim() }
            .firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
    }

    private fun extractAuthReturn(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        if (uri.scheme != "llmwiki" || uri.host != "auth") return null
        return uri.toString()
    }
}
