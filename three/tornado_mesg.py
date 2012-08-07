"""
tornado_mesg -- tornadoweb async SSL encrypted TCP communication
                between tornado servers using protobufs
"""

import datetime, errno, ssl, socket, struct, time   # system libraries

from tornado import ioloop, iostream

import mesg_pb2   # Google's protobuf

def listen(port):
    """Create a nonblocking socket listening for connections on the given port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setblocking(0)
    s.bind(('', port))
    s.listen(128)
    return s

# openssl req -batch -new -x509 -newkey rsa:2048 -days 9999 -nodes -keyout cakey.pem -out cacert.pem 

class TornadoConnectionServer(object):
    def __init__(self, port, message_handler, certfile, keyfile, idle_timeout=30):
        self._idle_timeout = idle_timeout # in seconds
        self._socket = listen(port)
        self._message_handler = message_handler
        self._certfile = certfile
        self._keyfile = keyfile
        io = ioloop.IOLoop.instance()
        io.add_handler(self._socket.fileno(), self.accept_backend_connection, io.READ)

    def accept_backend_connection(self, fd, events):
        while True:
            try:
                connection, address = self._socket.accept()
                connection = ssl.wrap_socket(connection, do_handshake_on_connect=False, server_side=True, certfile=self._certfile, keyfile=self._keyfile)
            except socket.error, e:
                if e.args[0] not in (errno.EWOULDBLOCK, errno.EAGAIN):
                    raise
                return
            connection.setblocking(0)
            self.handle_backend_connection(connection, address)

    def handle_backend_connection(self, connection, address):
        message_handler = self._message_handler
        idle_timeout = self._idle_timeout
        io = ioloop.IOLoop.instance()
        class C(object):
            stream = iostream.SSLIOStream(connection)
            last_mesg_time = time.time()
            def get_next_message(self):
                C.stream.read_bytes(4, self.read_mesg)
            def read_mesg(self, s):
                C.last_mesg_time = time.time()
                if len(s) < 4: # invalid data / connection closed, etc.
                    C.stream.close()
                else:
                    C.stream.read_bytes(struct.unpack('>L', s)[0], self.handle_mesg)
            def handle_mesg(self, s):
                m = mesg_pb2.Message()
                m.ParseFromString(s)
                message_handler(m)
                self.get_next_message()
            def idle_check(self):
                if C.stream.closed(): return
                if time.time() - C.last_mesg_time >= idle_timeout:
                    C.stream.close()
                else:
                    io.add_timeout(datetime.timedelta(seconds=float(idle_timeout)), c.idle_check)
        c = C()
        c.idle_check()
        c.get_next_message()

def connect(host, port):
    s = ssl.wrap_socket(socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0), do_handshake_on_connect=False)
    s.connect((host, port))
    return iostream.SSLIOStream(s)

tornado_connections = {}
def connect_to_tornado(host, port):
    key = (host, port)
    c = tornado_connections.get(key, None)
    if c is not None:
        if c._socket.closed():
            del tornado_connections[key]
        else:
            return c
    c = TornadoConnectionClient(host, port)
    tornado_connections[key] = c
    return c

class TornadoConnectionClient(object):
    def __init__(self, host, port):
        self._socket = connect(host, port)
    def send(self, mesg, callback=None):
        s = mesg.SerializeToString()
        length_header = struct.pack(">L", len(s))
        self._socket.write(length_header + s, callback)
    
