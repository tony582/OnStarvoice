import java.lang.reflect.Method;

/** Invoked by Android's shell app_process for a single touchscreen gesture. */
public final class StarVoiceHeldSwipe {
    public static void main(String[] args) throws Exception {
        if (args.length != 6) throw new IllegalArgumentException("Expected six numeric arguments");
        int x1 = number(args[0], 0, 4000);
        int y1 = number(args[1], 0, 4000);
        int x2 = number(args[2], 0, 4000);
        int y2 = number(args[3], 0, 4000);
        int movementMs = number(args[4], 100, 2000);
        int holdMs = number(args[5], 100, 500);
        Touch touch = new Touch();
        long downAt = touch.now();
        float x = x1, y = y1;
        boolean completed = false;
        try {
            touch.send(0, downAt, downAt, x, y); // ACTION_DOWN
            long at = touch.now();
            while (at - downAt < movementMs) {
                float progress = (at - downAt) / (float) movementMs;
                x = x1 + (x2 - x1) * progress;
                y = y1 + (y2 - y1) * progress;
                touch.send(2, downAt, at, x, y); // ACTION_MOVE
                Thread.sleep(16);
                at = touch.now();
            }
            x = x2;
            y = y2;
            touch.send(2, downAt, at, x, y);
            Thread.sleep(holdMs);
            touch.send(2, downAt, touch.now(), x, y);
            completed = true;
        } finally {
            touch.send(completed ? 1 : 3, downAt, touch.now(), x, y); // ACTION_UP or ACTION_CANCEL
        }
        System.out.println("held_swipe_ok");
    }

    private static int number(String value, int min, int max) {
        int parsed = Integer.parseInt(value);
        if (parsed < min || parsed > max) throw new IllegalArgumentException("Gesture argument out of range");
        return parsed;
    }

    // Resolve only the platform methods used by the Android 8.1 input command. The build needs no SDK jar.
    private static final class Touch {
        private final Method uptime;
        private final Method obtain;
        private final Method setSource;
        private final Method recycle;
        private final Method inject;
        private final Object manager;

        Touch() throws Exception {
            uptime = Class.forName("android.os.SystemClock").getMethod("uptimeMillis");
            Class<?> motion = Class.forName("android.view.MotionEvent");
            obtain = motion.getMethod("obtain", long.class, long.class, int.class, float.class, float.class, int.class);
            setSource = motion.getMethod("setSource", int.class);
            recycle = motion.getMethod("recycle");
            Class<?> input = Class.forName("android.hardware.input.InputManager");
            manager = input.getMethod("getInstance").invoke(null);
            inject = input.getMethod("injectInputEvent", Class.forName("android.view.InputEvent"), int.class);
        }

        long now() throws Exception {
            return (Long) uptime.invoke(null);
        }

        void send(int action, long downAt, long at, float x, float y) throws Exception {
            Object event = obtain.invoke(null, downAt, at, action, x, y, 0);
            try {
                setSource.invoke(event, 0x1002); // SOURCE_TOUCHSCREEN
                if (!Boolean.TRUE.equals(inject.invoke(manager, event, 2))) {
                    throw new IllegalStateException("Touch injection failed");
                }
            } finally {
                recycle.invoke(event);
            }
        }
    }
}
