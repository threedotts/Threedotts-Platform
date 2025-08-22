import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  console.log('=== ElevenLabs Multi-Context WebSocket Proxy Started ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight');
    return new Response('ok', { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";
  console.log('Upgrade header:', upgradeHeader);

  if (upgradeHeader.toLowerCase() !== "websocket") {
    console.log('Not a WebSocket request, upgrade header:', upgradeHeader);
    return new Response("Expected WebSocket connection", { 
      status: 400,
      headers: corsHeaders 
    });
  }

  try {
    const url = new URL(req.url);
    const voiceId = url.searchParams.get('voice_id');
    const modelId = url.searchParams.get('model_id') || 'eleven_flash_v2_5';
    console.log('Voice ID from params:', voiceId);
    console.log('Model ID from params:', modelId);
    
    if (!voiceId) {
      console.log('Missing voice_id parameter');
      return new Response("Missing voice_id parameter", { 
        status: 400,
        headers: corsHeaders 
      });
    }

    const elevenLabsApiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!elevenLabsApiKey) {
      console.log('ElevenLabs API key not configured');
      return new Response("ElevenLabs API key not configured", { 
        status: 500,
        headers: corsHeaders 
      });
    }
    console.log('API Key configured (length):', elevenLabsApiKey.length);

    console.log('Upgrading WebSocket connection...');
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    // Add connection timeout
    let connectionTimeout: number;
    let elevenLabsWs: WebSocket | null = null;
    
    // Handle client connection
    socket.onopen = () => {
      console.log('Client WebSocket connected, initiating ElevenLabs multi-context connection...');
      
      // Clear any existing timeout
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      
      // Set connection timeout
      connectionTimeout = setTimeout(() => {
        console.log('Connection timeout, closing sockets');
        if (elevenLabsWs) elevenLabsWs.close();
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1008, 'Connection timeout');
        }
      }, 10000); // 10 second timeout
      
      try {
        const elevenLabsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input?model_id=${modelId}`;
        console.log('Connecting to ElevenLabs Multi-Context API:', elevenLabsUrl);
        
        // Create WebSocket without custom headers (not supported properly)
        elevenLabsWs = new WebSocket(elevenLabsUrl);
        
        elevenLabsWs.onopen = () => {
          console.log('✅ ElevenLabs Multi-Context WebSocket connected successfully');
          clearTimeout(connectionTimeout);
          
          // Send API key as first message (required by ElevenLabs)
          const authMessage = {
            xi_api_key: elevenLabsApiKey
          };
          console.log('Sending authentication message');
          elevenLabsWs.send(JSON.stringify(authMessage));
          
          // Notify client that connection is ready
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'connection_ready',
              message: 'Connected to ElevenLabs Multi-Context API successfully'
            }));
          }
        };

        elevenLabsWs.onmessage = (event) => {
          console.log('📨 Message from ElevenLabs:', typeof event.data);
          try {
            const data = JSON.parse(event.data);
            console.log('📨 Parsed message:', data.contextId ? `Context: ${data.contextId}` : 'No context', 
                       data.audio ? 'Has audio' : 'No audio', 
                       data.is_final ? 'Final' : 'Not final');
          } catch (e) {
            console.log('📨 Raw message length:', event.data.length);
          }
          
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(event.data);
          }
        };

        elevenLabsWs.onclose = (event) => {
          console.log('❌ ElevenLabs WebSocket closed:', event.code, event.reason);
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(event.code, event.reason);
          }
        };

        elevenLabsWs.onerror = (error) => {
          console.error('❌ ElevenLabs WebSocket error:', error);
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, 'ElevenLabs connection error');
          }
        };
        
      } catch (error) {
        console.error('Error creating ElevenLabs WebSocket:', error);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1011, 'Failed to connect to ElevenLabs');
        }
      }
    };

    socket.onmessage = (event) => {
      console.log('📤 Message from client:', typeof event.data, event.data.substring(0, 100) + '...');
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(event.data);
      } else {
        console.log('ElevenLabs WebSocket not ready, state:', elevenLabsWs?.readyState);
      }
    };

    socket.onclose = (event) => {
      console.log('Client WebSocket closed:', event.code, event.reason);
      clearTimeout(connectionTimeout);
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    };

    socket.onerror = (error) => {
      console.error('Client WebSocket error:', error);
      clearTimeout(connectionTimeout);
    };

    return response;

  } catch (error) {
    console.error('❌ Error in WebSocket proxy setup:', error);
    return new Response(`WebSocket proxy error: ${error.message}`, { 
      status: 500,
      headers: corsHeaders 
    });
  }
});