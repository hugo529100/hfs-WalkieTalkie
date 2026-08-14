import socket
import threading
import base64
import hashlib
import json
import argparse
import time
import sys
import os
import logging
from datetime import datetime

# 设置工作目录为脚本所在目录
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

# 配置日志系统
log_dir = os.path.join(script_dir, 'logs')
if not os.path.exists(log_dir):
    os.makedirs(log_dir)

log_file = os.path.join(log_dir, f'ws_server_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger('WebSocketServer')

clients = set()
clients_lock = threading.Lock()
controller_id = None
last_activity = {}

def create_handshake_response(key):
    GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    return (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n'
        '\r\n'
    )

def recv_ws_message(conn):
    try:
        data = conn.recv(2)
        if not data: 
            return None
            
        opcode = data[0] & 0x0F
        if opcode == 0x8:  # 关闭帧
            return None
            
        length = data[1] & 127
        if length == 126:
            data += conn.recv(2)
            length = int.from_bytes(data[2:4], byteorder='big')
        elif length == 127:
            data += conn.recv(8)
            length = int.from_bytes(data[2:10], byteorder='big')
            
        mask = conn.recv(4)
        msg = bytearray()
        for i in range(length):
            msg.append(conn.recv(1)[0] ^ mask[i % 4])
        return msg.decode('utf-8')
    except Exception as e:
        logger.error(f"Error receiving message: {e}")
        return None

def send_ws_message(conn, msg):
    try:
        encoded = msg.encode('utf-8')
        header = bytearray([0x81])  # FIN + text frame
        
        length = len(encoded)
        if length <= 125:
            header.append(length)
        elif length <= 65535:
            header.append(126)
            header.extend(length.to_bytes(2, byteorder='big'))
        else:
            header.append(127)
            header.extend(length.to_bytes(8, byteorder='big'))
            
        conn.sendall(header + encoded)
        return True
    except Exception as e:
        logger.error(f"Error sending message to {conn.getpeername()}: {e}")
        return False

def client_thread(conn, addr):
    global controller_id
    client_id = f"{addr[0]}:{addr[1]}"
    
    try:
        handshake = conn.recv(1024).decode('utf-8')
        if not handshake:
            logger.warning(f"Empty handshake from {addr}")
            conn.close()
            return
            
        key_lines = [line for line in handshake.split('\r\n') if line.startswith('Sec-WebSocket-Key:')]
        if not key_lines:
            logger.warning(f"Missing WebSocket key from {addr}")
            conn.close()
            return
            
        key = key_lines[0].split(': ')[1].strip()
        response = create_handshake_response(key)
        conn.sendall(response.encode('utf-8'))
        
        logger.info(f"Client connected: {addr}")

        with clients_lock:
            clients.add(conn)

        while True:
            msg = recv_ws_message(conn)
            if msg is None:
                break

            try:
                data = json.loads(msg)
                sender_id = data.get('senderId', client_id)
                last_activity[sender_id] = time.time()

                # 控制器过期处理
                if controller_id and time.time() - last_activity.get(controller_id, 0) > 5:
                    logger.info(f"Controller {controller_id} expired")
                    controller_id = None

                if controller_id in (None, sender_id):
                    controller_id = sender_id
                    with clients_lock:
                        active_clients = list(clients)
                        for c in active_clients:
                            if c != conn:
                                if not send_ws_message(c, msg):
                                    # 发送失败，移除客户端
                                    clients.discard(c)
                                    try:
                                        c.close()
                                    except:
                                        pass

            except Exception as e:
                logger.error(f"Error processing message from {addr}: {e}")

    except Exception as e:
        logger.error(f"Client error: {addr} - {e}")
    finally:
        try:
            with clients_lock:
                if conn in clients:
                    clients.remove(conn)
                    logger.info(f"Client disconnected: {addr}")
            conn.close()
        except:
            pass

def start_server(host, port):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port))
        s.listen(10)  # 增加积压连接数
        
        logger.info(f"Server started at ws://{host}:{port}")
        logger.info(f"Logging to: {log_file}")
        
        while True:
            try:
                conn, addr = s.accept()
                logger.debug(f"New connection from {addr}")
                client_handler = threading.Thread(target=client_thread, args=(conn, addr))
                client_handler.daemon = True
                client_handler.start()
            except Exception as e:
                logger.error(f"Accept error: {e}")
    except Exception as e:
        logger.critical(f"Server fatal error: {e}")
    finally:
        try:
            s.close()
        except:
            pass
        logger.info("Server stopped")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='WebSocket Sync Server')
    parser.add_argument('--port', type=int, default=8123, help='Port to listen on')
    parser.add_argument('--host', default='0.0.0.0', help='Host to bind to')
    args = parser.parse_args()
    
    logger.info("=" * 60)
    logger.info(f"Starting WebSocket Sync Server at {datetime.now()}")
    logger.info(f"Host: {args.host}, Port: {args.port}")
    logger.info("=" * 60)
    
    start_server(args.host, args.port)
