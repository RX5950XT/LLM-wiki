package com.llmwiki.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.llmwiki.ExternalEvent
import com.llmwiki.R
import com.llmwiki.data.WorkspaceRow
import com.llmwiki.data.SupabaseClientProvider
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import com.llmwiki.ui.auth.AuthScreen
import com.llmwiki.ui.settings.SettingsScreen
import com.llmwiki.ui.wiki.WikiScreen
import com.llmwiki.ui.workspace.WorkspaceCreateScreen

@Composable
fun LlmWikiNavGraph(
    shareUrlEvent: ExternalEvent? = null,
    authReturnEvent: ExternalEvent? = null,
) {
    val navController = rememberNavController()
    var accountName by rememberSaveable { mutableStateOf("") }

    NavHost(navController = navController, startDestination = "launch") {
        composable("launch") {
            LaunchRoute(
                onResolved = { destination ->
                    accountName = destination.accountName
                    navController.navigate(destination.route) {
                        popUpTo("launch") { inclusive = true }
                    }
                },
            )
        }
        composable("auth") {
            AuthScreen(
                onAuthenticated = { authState ->
                    accountName = authState.accountName
                    val wsId = authState.workspaceId
                    val route = if (wsId != null) "wiki?workspaceId=$wsId" else "workspace-create"
                    navController.navigate(route) {
                        popUpTo("auth") { inclusive = true }
                    }
                },
            )
        }
        composable(
            route = "wiki?workspaceId={workspaceId}",
            arguments = listOf(navArgument("workspaceId") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            }),
        ) { backStackEntry ->
            WikiScreen(
                workspaceId = backStackEntry.arguments?.getString("workspaceId"),
                accountName = accountName,
                shareUrl = shareUrlEvent?.value,
                authReturnUri = authReturnEvent?.value,
                onNavigateToSettings = { navController.navigate("settings") },
                onNavigateToCreateWorkspace = { navController.navigate("workspace-create") },
                onSignedOut = {
                    navController.navigate("auth") {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }
        composable("workspace-create") {
            WorkspaceCreateScreen(
                canNavigateBack = navController.previousBackStackEntry != null,
                authReturnUri = authReturnEvent?.value,
                onBack = { navController.popBackStack() },
                onWorkspaceCreated = { workspaceId ->
                    navController.navigate("wiki?workspaceId=$workspaceId") {
                        popUpTo("workspace-create") { inclusive = true }
                    }
                },
            )
        }
        composable("settings") {
            SettingsScreen(
                onBack = { navController.popBackStack() },
            )
        }
    }
}

private data class LaunchDestination(
    val route: String,
    val accountName: String,
)

@Composable
private fun LaunchRoute(
    onResolved: (LaunchDestination) -> Unit,
) {
    val supabase = remember { SupabaseClientProvider.client }

    LaunchedEffect(supabase) {
        runCatching { supabase.auth.awaitInitialization() }
        val session = supabase.auth.currentSessionOrNull()
        val email = session?.user?.email.orEmpty()
        if (email.isBlank()) {
            onResolved(LaunchDestination(route = "auth", accountName = ""))
            return@LaunchedEffect
        }

        val workspaceId = runCatching {
            supabase.from("workspaces")
                .select()
                .decodeList<WorkspaceRow>()
                .firstOrNull()
                ?.id
        }.getOrNull()

        val route = if (workspaceId != null) {
            "wiki?workspaceId=$workspaceId"
        } else {
            "workspace-create"
        }
        onResolved(LaunchDestination(route = route, accountName = email))
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator()
            Text(
                text = androidx.compose.ui.res.stringResource(R.string.common_loading_placeholder),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
