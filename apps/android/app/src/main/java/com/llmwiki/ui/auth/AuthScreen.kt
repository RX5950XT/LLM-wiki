package com.llmwiki.ui.auth

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.llmwiki.R

@Composable
fun AuthScreen(
    onAuthenticated: (AuthState.Success) -> Unit,
    modifier: Modifier = Modifier,
    authViewModel: AuthViewModel = viewModel(),
) {
    val state by authViewModel.state.collectAsState()
    val context = LocalContext.current
    val googleSignInLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        authViewModel.handleGoogleSignInResult(result.data)
    }
    val launchGoogleAccountChooser: () -> Unit = {
        authViewModel.createGoogleSignInIntent(context)?.let { signInIntent ->
            authViewModel.clearGoogleSignInSession(context) {
                googleSignInLauncher.launch(signInIntent)
            }
        }
        Unit
    }

    LaunchedEffect(Unit) {
        authViewModel.restoreSessionIfPossible()
    }

    LaunchedEffect(state) {
        if (state is AuthState.Success) {
            onAuthenticated(state as AuthState.Success)
        }
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.auth_welcome),
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.auth_description),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(40.dp))

            when (val s = state) {
                is AuthState.Restoring -> CircularProgressIndicator()
                is AuthState.Loading -> CircularProgressIndicator()
                is AuthState.Error -> {
                    Text(
                        text = s.message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )
                    SignInButton(onClick = launchGoogleAccountChooser)
                }
                else -> SignInButton(onClick = launchGoogleAccountChooser)
            }
        }
    }
}

@Composable
private fun SignInButton(onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.widthIn(min = 240.dp),
    ) {
        Text(text = stringResource(R.string.auth_sign_in))
    }
}
