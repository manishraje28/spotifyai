// src/App.jsx

import React, { useState } from 'react';
import './App.css'; // We'll add some basic styling

function App() {
  const [command, setCommand] = useState('');
  const [message, setMessage] = useState('Login to get started.');
  const [isLoading, setIsLoading] = useState(false);

  // The backend server URL
  const backendUrl = 'http://localhost:8000';

  const handleLogin = () => {
    // Redirect the user to the backend's login route
    window.location.href = `${backendUrl}/login`;
  };

  const handleCommandSubmit = async (e) => {
    e.preventDefault();
    if (!command) {
      setMessage('Please enter a command.');
      return;
    }

    setIsLoading(true);
    setMessage(`Sending command: "${command}"...`);

    try {
      const response = await fetch(`${backendUrl}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage(`Successfully executed: ${command}`);
      } else {
        // Display a more helpful error from the backend
        const errorDetails = data.details?.error?.message || data.error || 'An unknown error occurred.';
        setMessage(`Error: ${errorDetails}`);
      }
    } catch (error) {
      console.error('Network or server error:', error);
      setMessage('Error connecting to the server. Is it running?');
    } finally {
      setIsLoading(false);
      setCommand(''); // Clear the input field
    }
  };

  return (
    <div className="container">
      <header className="header">
        <h1>AI Spotify Assistant</h1>
        <p>Control Spotify with natural language.</p>
      </header>
      
      <div className="card">
        <div className="status-message">
          <p>{message}</p>
        </div>
        
        <form onSubmit={handleCommandSubmit} className="command-form">
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="e.g., Play some relaxing music"
            className="command-input"
            disabled={isLoading}
          />
          <button type="submit" className="command-button" disabled={isLoading}>
            {isLoading ? 'Sending...' : 'Send Command'}
          </button>
        </form>

        <div className="login-container">
            <button onClick={handleLogin} className="login-button">
                Login with Spotify
            </button>
            <p className="login-note">You may need to log in again if your session expires.</p>
        </div>
      </div>

      <footer className="footer">
        <p>Built with Gemini & the Spotify Web API</p>
      </footer>
    </div>
  );
}

export default App;
